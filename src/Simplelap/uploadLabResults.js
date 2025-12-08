const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const moment = require('moment');

// ---------------------- CONFIG ---------------------- //
const MONGO_URI = 'mongodb://localhost:27017/pcc_labdata';
const baseDir = path.join(__dirname, 'pdf_output');
if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
const baseDirUpload = 'F:\\playwright-projects\\src\\Simplelap\\pdf_output';

const currentYear = new Date().getFullYear();
const startYear = 2023;
const YearObject = {};
for (let year = currentYear; year >= startYear; year--) {
    YearObject[year] = (currentYear - year).toString();
}

// ---------------------- SCHEMA ---------------------- //
const patientSchema = new mongoose.Schema({
    ResidentID: String,
    dos: String,
    Client: String,
    "Member ID#": String,
    DOB: String,
    status: { type: String, default: 'Pending' },
    logs: [String],
    disputeId: String,
    disputeIdFound: String,
    Message: String,
    files: {
        resultPdf: String,
        orderPdf: String,
        mergedPdf: String
    }
});
const Patient = mongoose.model('patients', patientSchema);
async function closeReconsiderationModal(page) {
    try {
        const backdrop = page.locator('.modal-backdrop');
        if (await backdrop.count()) {
            await backdrop.click({ position: { x: 10, y: 10 } });
        } else {
            await page.click('.modal-header button.close');
        }
        await page.waitForSelector('#reconsiderationModalLabel', { state: 'hidden', timeout: 10000 });
        console.log('✅ Modal closed successfully');
    } catch (err) {
        console.warn('⚠️ Could not close modal normally, forcing close...');
        await page.evaluate(() => {
            const modal = document.querySelector('#reconsiderationModal');
            if (modal) {
                modal.style.display = 'none';
                document.body.classList.remove('modal-open');
                const backdrop = document.querySelector('.modal-backdrop');
                if (backdrop) backdrop.remove();
            }
        });
    }
}

// ---------------------- MAIN ---------------------- //
(async () => {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB');

    const browser = await chromium.connectOverCDP('http://localhost:1000');
    const context = browser.contexts()[0];
    const page = context.pages().length ? context.pages()[0] : await context.newPage();

    const patients = await Patient.aggregate([
        {
            $match: {
                status: "success",
                Classification: { $in: ["LACK OF PRE-AUTHORIZATION", "MISSING MEDICAL RECORDS"] },
                dosMatchedCount: { $in: [2] },
                disputeId: null
            }
        },
        {
            $group: {
                _id: {
                    memberId: "$Member ID#",
                    DOB: "$DOB"
                },
                records: { $push: "$$ROOT" }
            }
        }
    ]);
    for (const memberGroup of patients) {

        const memberId = String(memberGroup._id.memberId);
        const dob = memberGroup._id.DOB;

        const records = memberGroup.records;

        console.log(`\n🩺 Processing Member: ${memberId} (DOB: ${dob}) — ${records.length} record(s)`);

        // Ensure main screen ready
        await page.waitForSelector('#providerProfileName', { state: 'visible', timeout: 20000 });
        await page.selectOption('#providerProfileName', { label: 'IL Medicaid' });

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'load' }),
            page.click('#medicalDropdownSubmitID')
        ]);

        // Fill member details
        await page.fill('#member-id', memberId);
        await page.type('#tDatePicker', moment(dob, 'M/D/YYYY').format("MMDDYYYY"));

        await page.waitForSelector('#action-type', { state: 'visible' });
        await page.click('#action-type');
        await page.waitForSelector('ul[role="listbox"]', { state: 'visible' });
        await page.locator('li', { hasText: 'View Eligibility & Patient Information' }).click();


        // let newPage;
        // try {
        //     const [popup] = await Promise.all([
        //         // Wait *briefly* for new page — but don't block forever
        //         context.waitForEvent('page', { timeout: 5000 }).catch(() => null),
        //         page.click('[data-testid="submitBtn"]')
        //     ]);

        //     newPage = popup; // may be null if no new tab opened
        // } catch (err) {
        //     console.error("❌ Error clicking submit:", err.message);
        //     continue;
        // }
        // // Check if "No Patients..." message appears
        // let noPatientFound = await page
        //     .locator('span[data-testid="NoPatientInfoFoundMessage"]')
        //     .isVisible({ timeout: 5000 })
        //     .catch(() => false);

        // // 🔁 If not found in IL Medicaid, retry with IL MMP Medicaid
        // if (noPatientFound) {
        //     console.log('⚠️ No Patients found under IL Medicaid — trying IL MMP Medicaid...');

        //     await page.selectOption('#providerProfileName', { label: 'IL MMP Medicaid' });
        //     await Promise.all([
        //         page.waitForNavigation({ waitUntil: 'load' }),
        //         page.click('#medicalDropdownSubmitID')
        //     ]);

        //     await page.fill('#member-id', memberId);
        //     await page.type('#tDatePicker', moment(dob, 'M/D/YYYY').format("MMDDYYYY"));

        //     await page.waitForSelector('#action-type', { state: 'visible' });
        //     await page.click('#action-type');
        //     await page.waitForSelector('ul[role="listbox"]', { state: 'visible' });
        //     await page.locator('li', { hasText: 'View Eligibility & Patient Information' }).click();

        //     const [retryPage] = await Promise.all([
        //         context.waitForEvent('page'),
        //         page.click('[data-testid="submitBtn"]')
        //     ]);

        //     // ✅ Recheck for "No Patients..." message again (separate check)
        //     noPatientFound = await page
        //         .locator('span[data-testid="NoPatientInfoFoundMessage"]')
        //         .isVisible({ timeout: 5000 })
        //         .catch(() => false);

        //     if (noPatientFound) {
        //         await Patient.updateMany(
        //             { "Member ID#": memberId, DOB: dob },
        //             { $set: { Message: "No Patients found — skipping this record", status: "completed" } }
        //         );
        //         console.log('⚠️ No Patients found under both Medicaid plans — skipping this record');
        //         continue;
        //     }

        //     // If found in IL MMP Medicaid, use retryPage going forward
        //     newPage = retryPage;
        // }
        let newPage;
        const plans = [
            "IL Medicaid",
            "IL MMP Medicaid",
            "IL MMP Medicare",
            "IL MMP Behavioral Health"
        ];

        let patientFound = false;

        for (const plan of plans) {
            try {
                console.log(`🩺 Checking for patients under: ${plan}`);

                // Select the provider plan
                await page.selectOption('#providerProfileName', { label: plan });
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'load' }),
                    page.click('#medicalDropdownSubmitID')
                ]);

                // Fill member ID and DOB again for each plan
                await page.fill('#member-id', memberId);
                await page.fill('#tDatePicker', moment(dob, 'M/D/YYYY').format("MMDDYYYY"));

                // Select "View Eligibility & Patient Information"
                await page.waitForSelector('#action-type', { state: 'visible' });
                await page.click('#action-type');
                await page.waitForSelector('ul[role="listbox"]', { state: 'visible' });
                await page.locator('li', { hasText: 'View Eligibility & Patient Information' }).click();

                // Click submit and check if a new page opened
                const [popup] = await Promise.all([
                    context.waitForEvent('page', { timeout: 5000 }).catch(() => null),
                    page.click('[data-testid="submitBtn"]')
                ]);

                newPage = popup; // may be null if no popup opened

                // Check for "No Patients found" message
                const noPatientFound = await page
                    .locator('span[data-testid="NoPatientInfoFoundMessage"]')
                    .isVisible({ timeout: 5000 })
                    .catch(() => false);

                if (!noPatientFound) {
                    console.log(`✅ Patient found under ${plan}`);
                    patientFound = true;
                    break; // exit loop and proceed
                } else {
                    console.log(`⚠️ No Patients found under ${plan} — trying next plan...`);
                }

            } catch (err) {
                console.error(`❌ Error checking ${plan}:`, err.message);
                continue;
            }
        }

        // 🔚 After all plans checked
        if (!patientFound) {
            await Patient.updateMany(
                { "Member ID#": memberId, DOB: dob },
                { $set: { Message: "No Patients found under any plan — skipping this record", status: "completed" } }
            );
            console.log('🚫 No Patients found under any of the four plans — skipping record');
            continue;
        }
        // ✅ Proceed with next steps using newPage
        console.log(`➡️ Proceeding with page for found patient...`);
        await newPage.waitForLoadState('domcontentloaded');

        // Go to Claims
        await newPage.locator('nav.ngfc_navdesk a[href="/careconnect/memberDetails/claims"]').click();
        await newPage.waitForSelector('form#claimStatusModel', { state: 'visible' });

        for (const patient of records) {
            try {
                console.log(`📅 Processing DOS: ${patient.dos} for Member: ${memberId}`);

                // Select year and month
                const date = moment(patient.dos, "M/D/YYYY");
                await newPage.selectOption('#mYear', { value: YearObject[date.format("YYYY")] });
                await newPage.selectOption('#mMonth', { value: date.month().toString() });

                await newPage.click('form#claimStatusModel button[name="submit"]');
                await newPage.waitForLoadState('networkidle');

                // Find matching DOS
                const targetDos = date.format("MM/DD/YYYY");  // e.g. "06/09/2025"
                const totalClaimBalance = patient['Total Claim Charges'];            // from patient['Total Claim Charges ']

                const claimRow = await newPage.locator('table#claim tbody tr').filter({
                    has: newPage.locator('td', { hasText: new RegExp(targetDos.replace(/\//g, '\\/')) }),
                    has: newPage.locator('td', { hasText: new RegExp(`\\${totalClaimBalance}`) }),
                    hasNot: newPage.locator('td', { hasText: /Paid/i })   // exclude Paid rows
                }).first();

                await newPage.waitForTimeout(2000)
                if ((await claimRow.count()) === 0) {

                    console.log(`⚠️ No claim found for DOS ${targetDos}`);
                    await Patient.updateOne(
                        { _id: patient._id },
                        { $set: { Message: "Claim Already Paid", status: "Failed" } }
                    );
                    if (!newPage.isClosed()) await newPage.close();
                    continue;
                }

                const claimLink = claimRow.locator('td a').first();
                await Promise.all([
                    newPage.waitForNavigation({ waitUntil: 'networkidle' }),
                    claimLink.click()
                ]);

                console.log(`✅ Claim page for ${targetDos} loaded ${totalClaimBalance}`);

                // Click Dispute Claim
                await newPage.click('a.dispute-claim');
                await newPage.waitForSelector('button[onclick*="appealClaimModal"]', { state: 'visible' });

                const isDisabled = await newPage.getAttribute('#reconsider-modal-button', 'disabled');
                if (isDisabled) {

                    await Patient.updateOne(
                        { _id: patient._id },
                        { $set: { Message: "Claim Already Disputed", status: "completed" } }
                    );
                    await newPage.waitForSelector('a[href="/careconnect/memberDetails/claims"].btn', { state: 'visible', timeout: 10000 });

                    // Click the button and wait for the page to reload
                    await Promise.all([
                        newPage.waitForNavigation({ waitUntil: 'networkidle' }),
                        newPage.click('a[href="/careconnect/memberDetails/claims"].btn')
                    ]);
                    continue;
                }

                await newPage.click('button[onclick*="appealClaimModal"]');
                await newPage.waitForSelector('#reconsiderationModal', { state: 'visible' });

                await newPage.selectOption('#reconsideration-type', { value: 'Audit_Medical_Records_Requested' });
                await newPage.fill('#reconsideration-notes', 'ATTACHED ARE THE REQUEST OF MEDICAL RECORDS');

                // const filePath = patient.mergedPdfs || patient.resultPdfs;
                // console.log("filePath", filePath)
                // await newPage.setInputFiles('#files', filePath);

                // Clean date used in your naming logic
                // Build common prefix (everything before timestamp)
                const filePrefix = `${patient.GroupClient}_${patient.ResidentID}_`;

                // Build regex to match your 3 file types with timestamp
                const regex = new RegExp(`^${filePrefix}(Merged|Result)_${moment(patient.dos, "M/D/YYYY").format("M_D_YYYY")}_.+\\.pdf$`, 'i');
                //console.log("regex",regex)
                //const sample = fs.readdirSync(baseDirUpload)
                //console.log("sample",JSON.stringify(sample))
                // Read all matching PDFs in the directory
                const matchingFiles = fs.readdirSync(baseDirUpload)
                    .filter(file => regex.test(file))
                    .map(file => path.join(baseDirUpload, file));

                console.log("Matching Files Length", matchingFiles.length, matchingFiles);

                if (matchingFiles.length === 0) {
                    console.log("⚠️ No matching PDF files found for upload");
                } else {
                    const seenGroups = new Set();
                    const uniqueFiles = [];

                    for (const filePath of matchingFiles) {
                        const fileName = path.basename(filePath);

                        // Extract pattern parts: (Merged|Result)_8_22_2025_13_42_1762855809625.pdf
                        const match = fileName.match(/(Merged|Result)_(\d+)_(\d+)_(\d+)_(\d+)_(\d+)_\d+\.pdf$/);

                        if (match) {
                            const [_, type, month, day, year, hour, minute] = match;
                            const groupKey = `${type}_${month}_${day}_${year}_${hour}_${minute}`;

                            if (!seenGroups.has(groupKey)) {
                                seenGroups.add(groupKey);
                                uniqueFiles.push(filePath);
                            }
                        } else {
                            console.log("⚠️ Skipped unmatched file:", fileName);
                        }
                    }

                    console.log("📄 Final unique PDFs (1 per hour–minute group):", uniqueFiles);

                    // ✅ Upload unique files
                    await newPage.setInputFiles('#files', uniqueFiles);
                }
                const checked = await newPage.isChecked('#include-email-updates');
                if (!checked) await newPage.check('#include-email-updates');

                await Promise.all([
                    newPage.waitForLoadState('networkidle'),
                    newPage.click('#disputeAppeal')
                ]);

                await newPage.waitForSelector('.reconsideration-success', { state: 'visible', timeout: 30000 });
                const successMessage = await newPage.textContent('.reconsideration-success');
                const match = successMessage.match(/#([A-Z0-9]+)/);

                if (match) {
                    const disputeId = match[1];
                    console.log("disputeId", disputeId)
                    await Patient.updateOne({ _id: patient._id }, { $set: { disputeId, disputeIdFound: "Found" } });
                    console.log(`🎉 Dispute Submitted: ${disputeId}`);
                } else {
                    await Patient.updateOne({ _id: patient._id }, { $set: { disputeId: null, disputeIdFound: successMessage } });
                    console.log('⚠️ No Dispute ID found');
                }
                await newPage.goto('https://provider.ilmeridian.com/careconnect/memberDetails/claims', { waitUntil: 'networkidle' });
                await newPage.waitForTimeout(2000); // give 2s buffer
                // // Wait for the "Back to Member Details" button to appear
                // await newPage.waitForSelector('a[href="/careconnect/memberDetails/claims"].btn', { state: 'visible', timeout: 5000 });

                // // Click the button and wait for the page to reload
                // await Promise.all([
                //     newPage.waitForNavigation({ waitUntil: 'networkidle' }),
                //     newPage.click('a[href="/careconnect/memberDetails/claims"].btn')
                // ]);
                // const backButton = await newPage.waitForSelector('//a[contains(text(), "Back to Claims")]', { timeout: 8000 });

                // await Promise.all([
                //     newPage.waitForNavigation({ waitUntil: 'networkidle' }),
                //     backButton.click()
                // ]);
            } catch (err) {
                console.error(`❌ Error for ${patient.ResidentID}:`, err.message);
            }
        }
        // ✅ Clean up page and prepare for next patient
        if (!newPage.isClosed()) await newPage.close();
        console.log('🧹 Closed claim page');
        await page.bringToFront();
        await page.waitForSelector('#providerProfileName', { state: 'visible', timeout: 20000 });
        console.log('🔁 Ready for next patient...');
    }
    await mongoose.disconnect();
    console.log('✅ MongoDB connection closed');
})();