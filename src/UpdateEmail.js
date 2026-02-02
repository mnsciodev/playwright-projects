const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const { mouse } = require("@computer-use/nut-js");
mouse.config.mouseSpeed = 800;

// ================================
// MongoDB
// ================================
const uri = 'mongodb://127.0.0.1:27017/';
const client = new MongoClient(uri);

// ================================
// RETRY: WAIT FOR CASE MANAGER TABLE
// ================================
async function waitForCaseManagerWithRetry(page, claimNumber, retries = 5) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`⏳ Waiting for Case Manager (Attempt ${attempt}/${retries})`);

            await page.waitForSelector(
                '#ctl00_BodyContent_CaseManagerContactView tbody tr:nth-child(2)',
                { timeout: 7000 }
            );

            console.log('✅ Case Manager table loaded');
            return true;

        } catch {
            console.log('⚠️ Not loaded, retrying...');

            if (attempt === retries) return false;

            await page.fill('#ctl00_BodyContent_txtclmnum', '');
            await page.fill('#ctl00_BodyContent_txtclmnum', claimNumber);
            await page.click('#ctl00_BodyContent_btnsubmit');
            await page.waitForTimeout(1500);
        }
    }
}

// ================================
// EXTRACT CASE MANAGER DATA
// ================================
async function extractCaseManagerData(page) {
    const row = page
        .locator('#ctl00_BodyContent_CaseManagerContactView tbody tr')
        .nth(1);

    return {
        claimsRep: (await row.locator('td').nth(0).innerText()).trim(),
        phone: (await row.locator('td').nth(1).innerText()).trim(),
        fax: (await row.locator('td').nth(2).innerText()).trim(),
        email: (await row.locator('td').nth(3).innerText()).trim()
    };
}

// ================================
// GO BACK TO CLAIM SEARCH PAGE
// ================================
async function goBackToClaimSearch(page) {
    await page.waitForSelector(
        'a[href="CaseManagerLookup.aspx"]',
        { state: 'visible', timeout: 10000 }
    );

    await page.click('a[href="CaseManagerLookup.aspx"]');

    await page.waitForSelector(
        '#ctl00_BodyContent_txtclmnum',
        { state: 'visible', timeout: 10000 }
    );
}

// ================================
// MAIN
// ================================
(async () => {
    try {
        await client.connect();
        const database = client.db('paxhealth');
        const patientsCollection = database.collection('claimslist');

        // Fetch claims NOT processed yet
        const patients = await patientsCollection.aggregate([
            {
                $match: {
                    Ready: "Completed",
                    CaseManagerFetched: { $ne: true }
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
            console.log('❌ No claims to process');
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
        // PROCESS CLAIMS
        // ================================
        for (const patient of patients) {

            if (!patient.ClaimNumber) continue;

            console.log(`\n▶ Processing Claim: ${patient.ClaimNumber}`);

            // Enter claim number
            await page.fill('#ctl00_BodyContent_txtclmnum', '');
            await page.fill('#ctl00_BodyContent_txtclmnum', patient.ClaimNumber);

            // Submit
            await page.click('#ctl00_BodyContent_btnsubmit');

            // Wait for Case Manager
            const ok = await waitForCaseManagerWithRetry(
                page,
                patient.ClaimNumber
            );

            if (!ok) {
                console.log(`❌ Case Manager not found for ${patient.ClaimNumber}`);
                await goBackToClaimSearch(page);
                continue;
            }

            // Extract Case Manager
            const caseManager = await extractCaseManagerData(page);

            console.log('📋 Case Manager:', caseManager);

            // Update DB
            await patientsCollection.updateMany(
                { ClaimNumber: patient.ClaimNumber },
                {
                    $set: {
                        ...caseManager,
                        CaseManagerFetched: true,
                        CaseManagerFetchedAt: new Date()
                    }
                }
            );

            console.log(`✅ Saved Case Manager for ${patient.ClaimNumber}`);

            // Go back for next claim
            await goBackToClaimSearch(page);

            await page.waitForTimeout(800);
        }

    } catch (err) {
        console.error('❌ Workflow error:', err);
    } finally {
        await client.close();
        console.log('🔒 MongoDB closed');
    }
})();
