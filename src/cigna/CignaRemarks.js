const { chromium } = require('playwright');
const { MongoClient, ObjectId } = require("mongodb");
const fs = require('fs');

async function getDataFromMongo(db) {
    const collection = db.collection("benifitmasters");
    return await collection.find({
        SuccessCode: "Ready",
        GediPayerID: "62308",
        PracticeId: new ObjectId("6493f5c990a4fb5cba6a1668")
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
                CignaRemarks: message,
            }
        }
    );
    return result;
}


function parseMoneyToNumber(str) {
    if (!str) return 0;
    const s = String(str).trim().toLowerCase();
    if (s.includes('no charge') || s.includes('no-cost') || s === 'n/a' || s === 'none') return 0;
    const m = s.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
    const fallback = Number(s.replace(/[^0-9.]/g, ''));
    return isNaN(fallback) ? 0 : fallback;
}


function parsePercentToNumber(str) {
    if (!str) return 0;
    const s = String(str).trim().toLowerCase();
    const m = s.match(/(\d{1,3})\s*%/);
    if (m) return parseInt(m[1], 10);
    const fallback = Number(s.replace(/[^0-9]/g, ''));
    return isNaN(fallback) ? 0 : fallback;
}

function formatCoverageText(serviceLabel, { copay, coinsurance }) {
    const copayNum = parseMoneyToNumber(copay);
    const coinsNum = parsePercentToNumber(coinsurance);

    if (copayNum > 0) {
        const display = copayNum % 1 === 0 ? `${parseInt(copayNum, 10)}` : `${copayNum.toFixed(2)}`;
        return `${serviceLabel} $${display} Copay`;
    }

    if (copayNum === 0 && coinsNum === 0) {
        return `${serviceLabel} Covered at 100%`;
    }

    if (copayNum === 0 && coinsNum > 0) {
        const coveredPercent = 100 - coinsNum;
        return `${serviceLabel} Covered at ${coveredPercent}% and ${coinsNum}% Coinsurance`;
    }

    return '';
}

function generateFinalRemarks(p) {
    const ov = p.professionalServices ? formatCoverageText('OV', p.professionalServices) : '';
    const lab = p.laboratory ? formatCoverageText('Lab', p.laboratory) : '';
    const chemo = p.oncology ? formatCoverageText('Chemo/Inj', p.oncology) : '';

    const dedIndividual = p.benefits['Individual Deductible'] || {};
    const dedFamily = p.benefits['Family Deductible'] || {};
    const oopIndividual = p.benefits['Individual Out-of-Pocket Maximum'] || {};
    const oopFamily = p.benefits['Family Out-of-Pocket Maximum'] || {};

    const parts = [
        `Member ID: ${p.patientId}`,
        'Cigna',
        `Eff Date ${p.currentCoverage}`,
        `Plan Name ${p.planType}`,
        p.remarks
    ].filter(Boolean);

    if (ov) parts.push(ov);
    if (lab) parts.push(lab);
    if (chemo) parts.push(chemo);

    parts.push(
        `DED ${dedIndividual.value || ''} met ${dedIndividual.met || ''}, ` +
        `Fam ${dedFamily.value || ''} met ${dedFamily.met || ''}, ` +
        `OOP ${oopIndividual.value || ''} met ${oopIndividual.met || ''}, ` +
        `Fam ${oopFamily.value || ''} met ${oopFamily.met || ''}`
    );

    return parts.join(', ');
}

(async () => {
    let client;

    try {
        console.log('Connecting to MongoDB...');
        client = new MongoClient(MONGO_URI);
        await client.connect();
        const db = client.db("trizetto");
        console.log('Connected to MongoDB');

        const records = await getDataFromMongo(db);
        if (records.length === 0) {
            console.log('No MongoDB records found!');
            return;
        }

        console.log(`Fetched ${records.length} records from MongoDB`);

        console.log('Connecting to browser...');
        const browser = await chromium.connectOverCDP('http://localhost:7456');
        const contexts = browser.contexts();
        const page = await contexts[0].newPage();

        console.log('Navigating to Cigna dashboard...');
        await page.goto('https://cignaforhcp.cigna.com/app/dashboard', { timeout: 60000 });

        const results = [];

        async function getCopayOrCoinsurance(serviceLabel) {
            console.log(`🔍 Extracting copay/coinsurance for: ${serviceLabel}`);

            await page.waitForTimeout(1500);

            const section = await page.$(`section:has-text("${serviceLabel}")`);
            if (!section) {
                console.log(`⚠️ No section found for ${serviceLabel}`);
                return { copay: 0, coinsurance: 0 };
            }

            let copayText = "";
            const copayRow = await section.$('h3:has-text("Copayment (Per Visit)") ~ table tbody tr');
            if (copayRow) {
                const amountCell = await copayRow.$("td:nth-child(1)");
                copayText = amountCell ? (await amountCell.textContent()).trim() : "";
            }

            let coinsText = "";
            const coinsHandle = await section.$('h3:has-text("Coinsurance")');
            if (coinsHandle) {
                coinsText = await coinsHandle.evaluate((el) => {
                    const s = el.nextElementSibling || el.parentElement.querySelector("div, span, td, p");
                    return s ? s.textContent.trim() : "";
                });
            }

            const copay = parseMoneyToNumber(copayText);
            const coinsurance = parsePercentToNumber(coinsText);

            console.log(`✅ ${serviceLabel} → Copay: ${copay}, Coinsurance: ${coinsurance}`);
            return { copay, coinsurance };
        }

        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            const {
                _id,
                PracticeName: practicename,
                SubscribersMemberID: patientId,
                PatientFirstName: patientFN,
                PatientLastName: patientLN,
                PatientDOB: patientDOB,
                DateOfService: asOfDate
            } = record;

            try {
                console.log(`Processing ${i + 1}/${records.length}: ${patientFN} ${patientLN}`);

                // Navigate and fill patient search form
                await page.hover('[data-test="primary-nav-chcp.patient"]');
                await page.click('a[href*="/app/patient/search"]');
                await page.waitForSelector('#patient_id_0', { state: 'visible', timeout: 10000 });

                await page.fill('#asOfDate', asOfDate);
                await page.fill('#patient_id_0', patientId);
                await page.fill('#patient_dob_0', patientDOB);
                await page.fill('#patient_LN_0', patientLN);
                await page.fill('#patient_FN_0', patientFN);

                await page.click('button[data-test="search-submit-button"]');
                await page.waitForTimeout(3000);

                const patientButton = await page.$('button[data-test="patient-id-0"]');
                if (!patientButton) {
                    console.log(`❌ Patient ${patientFN} (${patientId}) not found.`);
                    continue;
                }

                await patientButton.click();

                await page.waitForSelector('a[data-test="btn-confirm"]', { state: 'visible', timeout: 10000 });
                await page.click('a[data-test="btn-confirm"]');

                await page.waitForSelector('#network-type', { state: 'visible', timeout: 15000 });
                await page.selectOption('#network-type', 'INN');

                await page.click('[data-test="btn-see-general-benefits"]');
                await page.waitForSelector('td[data-test="plan-type"]', { state: 'visible', timeout: 10000 });

                const planType = (await page.locator('td[data-test="plan-type"]').textContent()).trim();
                const currentCoverage = (await page.locator('td[data-test="current-coverage"]').textContent()).trim();

                const headers = await page.$$eval('strong[data-test="lbl-header"]', els => els.map(el => el.textContent.trim()));
                const headerValues = await page.$$eval('strong[data-test="lbl-header"]', els =>
                    els.map(el => el.nextSibling ? el.nextSibling.textContent.trim() : '')
                );
                const barMetValues = await page.$$eval('dd[data-test="bar-met-value"]', els => els.map(el => el.textContent.trim()));
                const barRemainingValues = await page.$$eval('dd[data-test="bar-remaining-value"]', els => els.map(el => el.textContent.trim()));

                const benefits = {};
                headers.forEach((header, idx) => {
                    benefits[header.replace(':', '')] = {
                        value: headerValues[idx] || '',
                        met: barMetValues[idx] || '',
                        remaining: barRemainingValues[idx] || ''
                    };
                });

                await page.click('span[data-test="btn-Primary Care Physician (PCP) Name and Address"]');
                await page.waitForTimeout(500);

                let remarks = '';
                const pcpContent = await page.$('span[data-test="pcpcontent"]');
                if (pcpContent) {
                    const text = (await pcpContent.textContent()).trim();
                    if (text.includes("does not require a primary care physician")) {
                        remarks = 'Ref is not Req';
                    }
                } else {
                    remarks = 'Ref is Req';
                }

                const patientJson = {
                    asOfDate,
                    patientId,
                    patientDOB,
                    patientLN,
                    patientFN,
                    planType,
                    currentCoverage,
                    benefits,
                    remarks
                };

                if (practicename === "CHO New" || practicename === "CCSM") {
                    await page.click('[data-test="btn-Professional Services"]');
                    await page.waitForSelector('[data-test="btn-Professional (Physician) Visit - Office"]');
                    await page.click('[data-test="btn-Professional (Physician) Visit - Office"]');
                    await page.waitForTimeout(2000);
                    patientJson.professionalServices = await getCopayOrCoinsurance("Professional Services");

                    await page.click('[data-test="btn-Oncology"]');
                    await page.waitForSelector('[data-test="btn-Chemotherapy - Office"]');
                    await page.click('[data-test="btn-Chemotherapy - Office"]');
                    await page.waitForTimeout(2000);
                    patientJson.oncology = await getCopayOrCoinsurance("Chemotherapy - Office");

                    if (practicename === "CCSM") {
                        await page.click('[data-test="btn-Laboratory Services"]');
                        await page.waitForSelector('[data-test="btn-Laboratory Services - Office"]');
                        await page.click('[data-test="btn-Laboratory Services - Office"]');
                        await page.waitForTimeout(2000);
                        patientJson.laboratory = await getCopayOrCoinsurance("Laboratory Services - Office");
                    }
                }

                patientJson.finalRemarks = generateFinalRemarks(patientJson);
                results.push(patientJson);

                await updateProgress(db, _id, patientJson.finalRemarks);

                console.log(`✅ Processed & updated ${patientFN} ${patientLN}`);
            } catch (err) {
                console.log(`❌ Error on ${i + 1}: ${err.message}`);
                continue;
            }
        }

        fs.writeFileSync('patient_data.json', JSON.stringify(results, null, 2));
        console.log('✅ All patient data saved & updated!');
    } catch (err) {
        console.error('❌ Fatal Error:', err.message);
    } finally {
        if (client) await client.close();
    }
})();


