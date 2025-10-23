const { chromium } = require('playwright');
const { MongoClient, ObjectId } = require("mongodb");

async function getDataFromMongo(db) {
    const collection = db.collection("benifitmasters");
    return await collection.find({
        SuccessCode: "Ready",
        GediPayerID: "66901",
        PracticeId: new ObjectId("641d3c30aabef30b0a779650")
    }).toArray();
}
async function updateProgress(db, recordId, message) {
    const collection = db.collection("benifitmasters");

    const _id = typeof recordId === "string" ? new ObjectId(recordId) : recordId;

    const result = await collection.updateOne(
        { _id },
        {
            $set: {
                SuccessCode: "Success",
                BannerRemarks: message,
            }
        }
    );
    return result;
}
// Retry logic for selectors
async function retrySelector(page, selector, timeout = 30000, retries = 3) {
    let attempts = 0;
    while (attempts < retries) {
        try {
            await page.locator(selector).waitFor({ state: 'visible', timeout });
            return true;
        } catch (err) {
            attempts++;
            if (attempts >= retries) {
                console.error(`❌ Failed to find ${selector} after ${retries} attempts`);
                throw err;
            }
            console.log(`Retrying ${selector}... (${attempts}/${retries})`);
        }
    }
}

// Robust helper to get value by label
async function getFieldValueByLabel(page, containerSelector, labelText) {
    const container = page.locator(containerSelector);
    await container.waitFor({ state: 'attached', timeout: 3000 }).catch(() => { });
    const rowSelector = `tr:has(label:has-text("${labelText}"))`;
    const row = container.locator(rowSelector);
    if (await row.count() > 0) {
        const tds = row.locator('td');
        const tdCount = await tds.count();
        for (let i = 0; i < tdCount; i++) {
            const hasLabel = (await tds.nth(i).locator('label').count()) > 0;
            if (!hasLabel) {
                const txt = (await tds.nth(i).innerText()).trim();
                if (txt) return txt.replace(/\s+/g, ' ');
            }
        }
        if (tdCount >= 2) {
            const txt = (await tds.nth(1).innerText()).trim();
            if (txt) return txt.replace(/\s+/g, ' ');
        }
    }

    const labelElem = container.locator(`label:has-text("${labelText}")`);
    if (await labelElem.count() > 0) {
        const parentTd = labelElem.locator('xpath=ancestor::td[1]');
        if (await parentTd.count() > 0) {
            const sibling = parentTd.locator('xpath=following-sibling::td[1]');
            if (await sibling.count() > 0) {
                const txt = (await sibling.innerText()).trim();
                if (txt) return txt.replace(/\s+/g, ' ');
            }
        }
        const parentTr = labelElem.locator('xpath=ancestor::tr[1]');
        if (await parentTr.count() > 0) {
            const tds2 = parentTr.locator('td');
            const tc2 = await tds2.count();
            for (let i = 0; i < tc2; i++) {
                const hasLbl = (await tds2.nth(i).locator('label').count()) > 0;
                if (!hasLbl) {
                    const txt = (await tds2.nth(i).innerText()).trim();
                    if (txt) return txt.replace(/\s+/g, ' ');
                }
            }
        }
    }

    const textNode = container.locator(`text=${labelText}`);
    if (await textNode.count() > 0) {
        const el = textNode.first();
        const parentTr = el.locator('xpath=ancestor::tr[1]');
        if (await parentTr.count() > 0) {
            const tds = parentTr.locator('td');
            const tc = await tds.count();
            for (let i = 0; i < tc; i++) {
                const hasLbl = (await tds.nth(i).locator('label').count()) > 0;
                if (!hasLbl) {
                    const t = (await tds.nth(i).innerText()).trim();
                    if (t) return t.replace(/\s+/g, ' ');
                }
            }
        }
    }

    const xpathExpr = `//label[normalize-space(.)='${labelText}']/ancestor::tr[1]//td[not(.//label) and normalize-space()!=''][1]`;
    const xpathLocator = page.locator(`xpath=${xpathExpr}`);
    if (await xpathLocator.count() > 0) {
        return (await xpathLocator.first().innerText()).trim().replace(/\s+/g, ' ');
    }

    return '';
}

// Main function
(async () => {
    const client = new MongoClient("mongodb+srv://scioms:5NHRcnbEjLaXefKF@scioms.n5hcu.mongodb.net/trizetto?retryWrites=true&w=majority");
    const browser = await chromium.launch({ headless: false, channel: 'chrome' });
    const context = await browser.newContext();
    const page = await context.newPage();
    const results = [];

    try {

        // Connect to MongoDB
        await client.connect();
        const db = client.db("trizetto");
        const records = await getDataFromMongo(db);

        if (!records.length) {
            console.log("No records found in MongoDB.");
            return;
        }


        console.log('🔑 Logging in...');
        await page.goto('https://eservices.uph.org/Account/Login?ReturnUrl=%2F', { timeout: 60000 });
        await page.fill('#Email', 'hmatthews@scioms.com');
        await page.fill('#Password', 'Welcome@12345');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
            page.click('input[value="Log in"]')
        ]);
        console.log('✅ Logged in successfully.');

        await page.goto('https://eservices.uph.org/Member', { waitUntil: 'domcontentloaded' });
        try {
            for (const [index, row] of records.entries()) {

                const memberId = row.InsuranceNum;
                const patientDob = row.PatientDOB;
                const payerName = row.PayerName;
                console.log(`🔍 Searching for MemberID=${memberId}, DOB=${patientDob}`);

                await retrySelector(page, '#queryDOB', 10000);
                const dobField = page.locator('#queryDOB');
                await dobField.fill('');
                await dobField.type(patientDob.trim(), { delay: 50 });

                await retrySelector(page, '#queryID', 10000);
                const idField = page.locator('#queryID');
                await idField.fill('');
                await idField.fill(memberId);

                const findMemberBtn = page.locator('input[value="Find Member"]').first();
                await Promise.all([
                    page.waitForSelector('table.Listing[summary="matching members"] tbody tr', { timeout: 30000 }),
                    findMemberBtn.click()
                ]);

                const loader = page.locator('#resultLoading');
                await loader.waitFor({ state: 'hidden', timeout: 40000 }).catch(() => { });

                const resultsTable = page.locator('table.Listing[summary="matching members"] tbody tr');
                await resultsTable.first().waitFor({ state: 'visible', timeout: 40000 });

                const rowCount = await resultsTable.count();
                let foundMember = false;

                for (let i = 0; i < rowCount; i++) {
                    const firstTd = resultsTable.nth(i).locator('td').first();
                    if (await firstTd.count() === 0) continue;
                    const memberIdCell = (await firstTd.innerText()).trim();
                    if (!memberIdCell) continue;
                    if (memberIdCell === memberId) {
                        foundMember = true;
                        break;
                    }
                }

                if (!foundMember) {
                    console.log(`⚠️ Row ${index + 1} — No records found for Member ID: ${memberId}`);
                    results.push({ memberId, patientDob, found: false, data: null });
                    continue;
                }

                // Open member details in a new tab
                //const detailPage = await browser.newPage();
                const detailPage = await context.newPage();
                await detailPage.goto(`https://eservices.uph.org/Member/Details/${memberId}`, { waitUntil: 'domcontentloaded' });
                await detailPage.waitForSelector('#div_Results', { timeout: 10000 }).catch(() => { });


                const memberDetails = {};

                const detailSelectors = [
                    '#div_Results table.Listing tr',
                    '#div_Results table.Details tr',
                    '#div_Results table.DetailsSub tr',
                    '#div_Results table.DetailsSubStatic tr'
                ];

                for (const sel of detailSelectors) {
                    const detailRows = detailPage.locator(sel);
                    const dcount = await detailRows.count();
                    for (let i = 0; i < dcount; i++) {
                        const label = await detailRows.nth(i).locator('td label.DetailsLabel').innerText().catch(() => null);
                        if (!label) continue;
                        const tds = detailRows.nth(i).locator('td');
                        const tc = await tds.count();
                        let value = '';
                        for (let j = 0; j < tc; j++) {
                            const hasLabel = (await tds.nth(j).locator('label').count()) > 0;
                            if (!hasLabel) {
                                value = (await tds.nth(j).innerText()).trim();
                                if (value) break;
                            }
                        }
                        memberDetails[label] = value.replace(/\s+/g, ' ');
                    }
                }

                const providerName = await getFieldValueByLabel(detailPage, '#div_Results', 'Provider Name');
                if (providerName) memberDetails['Provider Name'] = providerName;

                const practiceName = await getFieldValueByLabel(detailPage, '#div_Results', 'Practice Name');
                if (practiceName) memberDetails['Practice Name'] = practiceName;

                // Extract Health Plan Enrollment Table
                await detailPage.waitForSelector('h4:has-text("Health Plan Enrollment")', { timeout: 5000 }).catch(() => { });

                const planTable = detailPage.locator('table.DetailsSub', { has: detailPage.locator('th:has-text("Health Plan")') });
                const hasPlanTable = await planTable.isVisible().catch(() => false);

                let hasActivePlan = false;
                let activeEffectiveDate = '';
                const plans = [];

                if (hasPlanTable) {
                    const planRows = planTable.locator('tbody tr');
                    const planCount = await planRows.count();

                    for (let i = 0; i < planCount; i++) {
                        const firstChildName = await planRows.nth(i).locator(':scope > *').first().evaluate((n) => n.nodeName).catch(() => null);
                        if (firstChildName === 'TH') continue;
                        const tds = planRows.nth(i).locator('td');
                        const tcount = await tds.count();
                        if (tcount < 1) continue;
                        const memberIdCell = (await tds.nth(0).innerText()).trim();
                        const healthPlan = tcount > 1 ? (await tds.nth(1).innerText()).trim() : '';
                        const effectiveDate = tcount > 2 ? (await tds.nth(2).innerText()).trim() : '';
                        const termDate = tcount > 3 ? (await tds.nth(3).innerText()).trim() : '';
                        const rateCode = tcount > 4 ? (await tds.nth(4).innerText()).trim() : '';
                        const className = await planRows.nth(i).getAttribute('class');
                        const isActive = className && className.includes('text-active');

                        if (isActive && !hasActivePlan) {
                            hasActivePlan = true;
                            activeEffectiveDate = effectiveDate;
                        }

                        plans.push({
                            memberId: memberIdCell,
                            healthPlan,
                            effectiveDate,
                            termDate,
                            rateCode,
                            active: isActive
                        });
                    }
                }

                if (!hasActivePlan) {
                    memberDetails['Remarks'] = 'Banner Inactive for This DOS';
                    await updateProgress(db, row._id, 'Banner Inactive for This DOS')
                } else {
                    const planType = memberId.startsWith('A') ? 'MCD HMO Plan' : 'MCR HMO Plan';
                    const ovChemoInj = memberId.startsWith('A')
                        ? 'OV/Chemo & Inj covers 100% of Medical Allowances'
                        : 'OV/Chemo & Inj covers 80% of Medical Allowances and 20% Coins';

                    var Remarks = `Member ID ${memberId}, Payer Name ${payerName}, Eff Date ${activeEffectiveDate}, Plan Name ${planType}, Referral required from PCP ${memberDetails['Provider Name'] || 'N/A'}, ${ovChemoInj}`
                    memberDetails['Remarks'] = Remarks

                    await updateProgress(db, row._id, Remarks)

                    memberDetails['EffectiveDate'] = activeEffectiveDate;
                }
                results.push({
                    memberId,
                    patientDob,
                    found: true,
                    data: memberDetails,
                    plans
                });
                await detailPage.close();

            }
        } catch (err) {
            console.error(`${err.message}`);
        }
    } catch (err) {
        console.error('❌ Script failed:', err.message);
    } finally {
        await browser.close();
    }
})();