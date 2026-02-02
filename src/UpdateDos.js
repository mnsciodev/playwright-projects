const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const { mouse } = require("@computer-use/nut-js");
mouse.config.mouseSpeed = 800;

// MongoDB
const uri = 'mongodb://127.0.0.1:27017/';
const client = new MongoClient(uri);

// ================================
// RETRY FUNCTION
// ================================
async function waitForRowsWithRetry(page, claimNumber, retries = 5) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`⏳ Waiting for results (Attempt ${attempt}/${retries})`);

            const rows = page.locator('#accordion tbody tr[role="button"]');
            await rows.first().waitFor({ timeout: 5000 });

            console.log('✅ Rows loaded');
            return true;

        } catch {
            console.log('⚠️ Rows not loaded, retrying...');

            if (attempt === retries) return false;

            // re-submit
            await page.fill('#claim_num', '');
            await page.fill('#claim_num', claimNumber);
            await page.click('#btnSubmit');
            await page.waitForTimeout(1500);
        }
    }
}

// ================================
// MAIN
// ================================
(async () => {
    try {
        await client.connect();
        const database = client.db('paxhealth');
        const patientsCollection = database.collection('claimslist');

        // Fetch only NOT processed claims
        const patients = await patientsCollection.aggregate([
            {
                $match: {
                    Ready: "Completed",
                    BillsFetched: { $ne: true }
                }
            },
            {
                $group: {
                    _id: "$Patient Name",
                    ClaimNumber: { $first: "$ClaimNumber" }
                }
            }
        ]).toArray();

        if (!patients.length) {
            console.log('❌ No patients to process');
            return;
        }

        console.log(`✅ Found ${patients.length} claims`);

        // Browser
        const browser = await chromium.connectOverCDP('http://localhost:9222');
        const context = browser.contexts()[0];
        const page = context.pages().length
            ? context.pages()[0]
            : await context.newPage();

        // ================================
        // LOOP CLAIMS
        // ================================
        for (const patient of patients) {

            console.log(`\n▶ Processing Claim: ${patient.ClaimNumber}`);
            if(!patient.ClaimNumber){
                continue;
            }
            await page.fill('#claim_num', '');
            await page.fill('#claim_num', patient.ClaimNumber);
            await page.click('#btnSubmit');

            const success = await waitForRowsWithRetry(page, patient.ClaimNumber);

            if (!success) {
                console.log(`❌ No results for ${patient.ClaimNumber}`);
                continue;
            }

            const rows = page.locator('#accordion tbody tr[role="button"]');
            const count = await rows.count();

            const DataArray = [];

            for (let i = 0; i < count; i++) {
                const row = rows.nth(i);

                const billNumber = (await row.locator('td').nth(0).innerText())
                    .replace(/\D/g, '');

                const dos = (await row.locator('td').nth(2).innerText()).trim();

                DataArray.push({
                    ClaimNumber: patient.ClaimNumber,
                    billNumber,
                    dos
                });
            }

            // ================================
            // SAVE JSON (CRASH SAFE)
            // ================================
            if (DataArray.length > 0) {

                const filePath = path.join(
                    __dirname,
                    'output',
                    `claim_${patient.ClaimNumber}.json`
                );

                fs.mkdirSync(path.dirname(filePath), { recursive: true });

                fs.writeFileSync(
                    filePath,
                    JSON.stringify(DataArray, null, 2),
                    'utf8'
                );

                console.log(`📁 JSON saved: ${filePath}`);

                // ================================
                // DB BULK UPDATE
                // ================================
                const bulkOps = DataArray.map(item => ({
                    updateMany: {
                        filter: {
                            ClaimNumber: item.ClaimNumber,
                            "Date of Service": item.dos
                        },
                        update: {
                            $set: {
                                billNumber: item.billNumber,
                                UpdatedAt: new Date()
                            }
                        }
                    }
                }));

                await patientsCollection.bulkWrite(bulkOps);

                // Mark claim as completed
                await patientsCollection.updateMany(
                    { ClaimNumber: patient.ClaimNumber },
                    {
                        $set: {
                            BillsFetched: true,
                            BillsFetchedAt: new Date()
                        }
                    }
                );

                console.log(`✅ Claim ${patient.ClaimNumber} completed`);
            }

            await page.waitForTimeout(1000);
        }

    } catch (err) {
        console.error('❌ Workflow error:', err);
    } finally {
        await client.close();
        console.log('🔒 MongoDB closed');
    }
})();
