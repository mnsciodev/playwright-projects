const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const moment = require('moment');

// ---------------------- CONFIG ---------------------- //
const MONGO_URI = 'mongodb://localhost:27017/pcc_labdata';
const baseDir = path.join(__dirname, 'pdf_output');
if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

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
                status: "completed",
                Classification: "MISSING MEDICAL RECORDS"
            }
        },
        {
            $group: {
                _id: {
                    memberId: "$Member ID#",
                    dos: "$dos"
                },
                records: { $push: "$$ROOT" }
            }
        }
    ]);
    for (const memberGroup of patients) {

        const memberId = String(memberGroup._id.memberId);
        const dob = memberGroup._id.dob;

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


        const [newPage] = await Promise.all([
            context.waitForEvent('page'),
            page.click('[data-testid="submitBtn"]')
        ]);
        // ✅ Check if "No Patients..." message appears
        const noPatientFound = await newPage.locator('span[data-testid="NoPatientInfoFoundMessage"]').isVisible({ timeout: 5000 }).catch(() => false);

        if (noPatientFound) {
            await Patient.updateMany(
                { "Member ID#": memberId, DOB: dob },
                { $set: { Message: "No Patients found — skipping this record", status: "completed" } }
            );
            console.log('⚠️ No Patients found — skipping this record');
            continue;
        }
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
                const targetDos = date.format("MM/DD/YYYY");
                const claimRow = await newPage.locator('table#claim tbody tr').filter({
                    has: newPage.locator(`td:has-text("${targetDos}")`)
                }).first();

                if ((await claimRow.count()) === 0) {
                    console.log(`⚠️ No claim found for DOS ${targetDos}`);
                    if (!newPage.isClosed()) await newPage.close();
                    continue;
                }

                const claimLink = claimRow.locator('td a').first();
                await Promise.all([
                    newPage.waitForNavigation({ waitUntil: 'networkidle' }),
                    claimLink.click()
                ]);

                console.log(`✅ Claim page for ${targetDos} loaded`);

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

                const filePath = patient.files.mergedPdf || patient.files.resultPdf;
                console.log("filePath", filePath)
                await newPage.setInputFiles('#files', filePath);

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
                    await Patient.updateOne({ _id: patient._id }, { $set: { disputeId } });
                    console.log(`🎉 Dispute Submitted: ${disputeId}`);
                } else {
                    await Patient.updateOne({ _id: patient._id }, { $set: { disputeId: "", status: "NoDisputeID" } });
                    console.log('⚠️ No Dispute ID found');
                }

                // Wait for the "Back to Member Details" button to appear
                await newPage.waitForSelector('a[href="/careconnect/memberDetails/claims"].btn', { state: 'visible', timeout: 5000 });

                // Click the button and wait for the page to reload
                await Promise.all([
                    newPage.waitForNavigation({ waitUntil: 'networkidle' }),
                    newPage.click('a[href="/careconnect/memberDetails/claims"].btn')
                ]);

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