const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const moment = require("moment");
const { mouse } = require("@computer-use/nut-js");
mouse.config.mouseSpeed = 800;

// IMPORTANT: force IPv4
const uri = 'mongodb://127.0.0.1:27017/';
const client = new MongoClient(uri);

(async () => {
    try {
        await client.connect();
        const database = client.db('paxhealth');
        const patientsCollection = database.collection('claimslist');

        const patients = await patientsCollection.aggregate([
            {
                $match: { Ready: "Pending" }
            },
            {
                $group: {
                    _id: "$Patient Name",

                    DOB: { $first: "$DOB" },
                    DateOfInjury: { $first: "$Date of Injury" },
                    LastName: { $first: "$Last Name" },
                    PatientName: { $first: "$Patient Name" },
                    docId: { $first: "$_id" }
                }
            }
        ]).toArray();

        if (!patients.length) {
            console.log('No patients found in DB');
            return;
        }

        console.log(`Found ${patients.length} patients`);

        const browser = await chromium.connectOverCDP('http://localhost:9222');
        const context = browser.contexts()[0];
        const page = context.pages().length
            ? context.pages()[0]
            : await context.newPage();


        for (const patient of patients) {

            console.log(`\n▶ Processing: ${patient.LastName}, ${patient.PatientName}`);

            try {
                await page.waitForSelector('input[type="radio"]', {
                    timeout: 3000,
                    state: 'visible'
                });

                console.log('🔘 Radio found → clicking No → Yes');
                await page.getByRole('radio', { name: 'No' }).check();
                await page.getByRole('radio', { name: 'Yes' }).check();

            } catch {
                console.log('ℹ️ Radio NOT found → skipping');
            }
            await page.fill('#Search_DOB', '');
            await page.fill('#Search_AccDt', '');
            await page.fill('#Search_LastName', '');

            await page.fill('#Search_DOB', patient.DOB);
            await page.fill('#Search_AccDt', patient.DateOfInjury);
            await page.fill('#Search_LastName', patient.LastName);

            await page.waitForSelector('#btnSubmit', { state: 'visible' });
            await page.click('#btnSubmit');
            await Promise.race([
                page.waitForSelector('#results table tbody tr', { timeout: 30000 }),
                page.waitForSelector('#results:has-text("No")', { timeout: 30000 })
            ]);

            const rowCount = await page.locator('#results table tbody tr').count();

            if (rowCount > 0) {
                const claimNumber = await page.locator(
                    '#results table tbody tr:first-child td:first-child'
                ).innerText();

                const cleanClaimNumber = claimNumber.trim();
                console.log('✅ Claim Number:', cleanClaimNumber);

                await patientsCollection.updateMany(
                    { "Patient Name": patient.PatientName },
                    {
                        $set: {
                            ClaimNumber: cleanClaimNumber,
                            Ready: "Completed",
                            ProcessedAt: new Date()
                        }
                    }
                );
            } else {
                const message = (await page.textContent('#results')) || 'No Data';
                console.log('❌ No Result');
                await patientsCollection.updateMany(
                    { "Patient Name": patient.PatientName },
                    {
                        $set: {
                            Ready: "NotFound",
                            ResultMessage: message.trim(),
                            ProcessedAt: new Date()
                        }
                    }
                );
            }
            await page.waitForTimeout(800);
        }
    } catch (err) {
        console.error('❌ Workflow error:', err);
    } finally {
        await client.close();
        console.log('🔒 MongoDB connection closed');
    }
})();