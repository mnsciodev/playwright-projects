const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const mongoose = require('mongoose');

// ---------------------- CONFIG ---------------------- //
const MONGO_URI = 'mongodb://localhost:27017/pcc_labdata'; // change as needed
const baseDir = path.join(__dirname, 'pdf_output');
if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

// ---------------------- SCHEMAS ---------------------- //
const patientSchema = new mongoose.Schema({
    ResidentID: String,
    dos: String,
    Client: String,
    status: { type: String, default: 'Pending' },
    logs: [String],
    files: [
        {
            dos: String,
            resultPdfs: [String],
            orderPdfs: [String],
            mergedPdfs: [String],
        }
    ],
    dosMatchedCount: { type: Number, default: 0 }
});

const Patient = mongoose.model('patients', patientSchema);

// ---------------------- HELPERS ---------------------- //
function logPatient(patient, msg) {
    patient.logs = patient.logs || [];
    patient.logs.push(`${new Date().toISOString()} - ${msg}`);
    console.log(`🩺 [${patient.ResidentID}] ${msg}`);
}

async function saveLogToDb(patient) {
    try {
        await patient.save();
    } catch (err) {
        console.error(`DB Save Error: ${err.message}`);
    }
}

async function mergePdfs(resultsPdfPath, orderPdfPath, mergedPath) {
    const mergedPdf = await PDFDocument.create();
    const resultsPdf = await PDFDocument.load(fs.readFileSync(resultsPdfPath));
    const orderPdf = await PDFDocument.load(fs.readFileSync(orderPdfPath));

    const resultsPages = await mergedPdf.copyPages(resultsPdf, resultsPdf.getPageIndices());
    resultsPages.forEach(p => mergedPdf.addPage(p));

    const orderPages = await mergedPdf.copyPages(orderPdf, orderPdf.getPageIndices());
    orderPages.forEach(p => mergedPdf.addPage(p));

    const mergedBytes = await mergedPdf.save();
    fs.writeFileSync(mergedPath, mergedBytes);
}

// ---------------------- MAIN SCRIPT ---------------------- //
(async () => {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB");

    const GroupByClients = await Patient.aggregate([
        { $match: { status: { $ne: "completed" } } },
        { $group: { _id: "$Client" } }
    ]);

    if (GroupByClients.length === 0) {
        console.log('No Pending patients found in database.');
        return;
    }

    const browser = await chromium.launch({ headless: false, channel: 'chrome' });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // --- LOGIN ---
        await page.goto('https://www30.pointclickcare.com/home/login.jsp', { timeout: 60000 });
        await page.fill('[name="un"]', 'nexushm.mwatkins');
        await page.click('#id-next');
        await page.waitForSelector('[data-test="login-password-input"]', { state: 'visible', timeout: 20000 });
        await page.fill('[data-test="login-password-input"]', 'Welcome4Bria@simple1');
        await page.click('[data-test="login-signIn-button"]');
        await page.waitForSelector('#searchField', { state: 'visible', timeout: 60000 });
        await page.waitForTimeout(3000);

        for (const GetLocation of GroupByClients) {
            const facilityName = GetLocation._id;
            await page.click('#pccFacLink');
            await page.waitForSelector('#optionList li', { state: 'visible' });

            const facilityLocator = page.locator('ul#optionList a', {
                hasText: new RegExp(`^${facilityName.trim()}.*`, 'i')
            });

            await facilityLocator.waitFor({ state: 'visible', timeout: 10000 });
            await facilityLocator.click();
            await page.waitForLoadState('networkidle');

            const patients = await Patient.find({ status: { $ne: "completed" }, Client: facilityName });
            await page.waitForTimeout(3000);

            for (const patient of patients) {
                try {
                    await page.fill('#searchField', patient.ResidentID);
                    await Promise.all([
                        page.keyboard.press('Enter'),
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { })
                    ]);

                    await page.click('a[href*="labResults.xhtml"]');
                    await page.waitForSelector('#filterTrigger', { state: 'visible', timeout: 30000 });

                    const filterImg = await page.$('#filterTrigger img.plussign_img');
                    if (filterImg) {
                        const src = await filterImg.getAttribute('src');
                        if (src.includes('newplus.gif')) {
                            await page.click('#filterTrigger');
                            await page.waitForFunction(() => {
                                const img = document.querySelector('#filterTrigger img.plussign_img');
                                return img && img.src.includes('newminus.gif');
                            }, { timeout: 10000 });
                        }
                    }

                    await page.fill('#reported_date_dummy', '');
                    await page.fill('#collection_date_dummy', '');
                    await Promise.all([
                        page.click('#refreshButtonId'),
                        page.waitForSelector('#resultsTable', { state: 'visible', timeout: 60000 })
                    ]);

                    const rows = await page.$$('#resultsTable tbody tr');
                    if (rows.length === 0) {
                        logPatient(patient, 'No lab results found.');
                        patient.status = 'no-results';
                        await saveLogToDb(patient);
                        continue;
                    }

                    let matchedCount = 0;

                    for (const row of rows) {
                        const collectionDate = await row.$eval('td:nth-child(6) span', el => el.textContent.trim());
                        if (!collectionDate.includes(patient.dos)) continue;

                        matchedCount++;
                        const cleanDate = collectionDate.replace(/[/: ]/g, '_');
                        const ts = Date.now();
                        const resultPdfPath = path.join(baseDir, `${patient.ResidentID}_Result_${cleanDate}_${ts}.pdf`);
                        const orderPdfPath = path.join(baseDir, `${patient.ResidentID}_Order_${cleanDate}_${ts}.pdf`);
                        const mergedPdfPath = path.join(baseDir, `${patient.ResidentID}_Merged_${cleanDate}_${ts}.pdf`);

                        // Ensure patient.files exists (safety)
                        if (!Array.isArray(patient.files)) patient.files = [];

                        // get or create dosEntry
                        let dosEntry = patient.files.find(f => f.dos === collectionDate);
                        if (!dosEntry) {
                            dosEntry = { dos: collectionDate, resultPdfs: [], orderPdfs: [], mergedPdfs: [] };
                            patient.files.push(dosEntry);
                        }

                        // ---- DOWNLOAD RESULT PDF ---- //
                        try {
                            const actionsMenu = await row.$('a.pccActionMenu');
                            await actionsMenu.click();
                            const viewResults = await row.$('li:has-text("View Results")');

                            if (viewResults) {
                                const [popup] = await Promise.all([page.waitForEvent('popup'), viewResults.click()]);
                                await popup.waitForLoadState('domcontentloaded');

                                const viewFileBtn = await popup.$('#viewFileButton');
                                if (viewFileBtn) {
                                    const [pdfPopup] = await Promise.all([
                                        popup.context().waitForEvent('page'),
                                        viewFileBtn.click()
                                    ]);
                                    await pdfPopup.waitForLoadState('domcontentloaded');
                                    const pdfUrl = pdfPopup.url();

                                    // request and check content-type
                                    const pdfResponse = await page.request.get(pdfUrl);
                                    const contentType = (pdfResponse.headers()['content-type'] || '').toLowerCase();
                                    if (contentType.includes('application/pdf')) {
                                        fs.writeFileSync(resultPdfPath, await pdfResponse.body());
                                        logPatient(patient, `Result PDF downloaded: ${resultPdfPath}`);
                                        // push result path (before any unlink)
                                        dosEntry.resultPdfs.push(resultPdfPath);
                                    } else {
                                        logPatient(patient, `Skipped non-PDF result (content-type: ${contentType}) for ${collectionDate}`);
                                    }
                                    await pdfPopup.close();
                                }
                                await popup.close();
                            } else {
                                logPatient(patient, `No 'View Results' option for ${collectionDate}`);
                            }
                        } catch (err) {
                            logPatient(patient, `Result download error for ${collectionDate}: ${err.message}`);
                        }

                        // ---- DOWNLOAD ORDER PDF ---- //
                        try {
                            const actionsMenuOrder = await row.$('a.pccActionMenu');
                            await actionsMenuOrder.click();
                            const viewOrder = await row.$('li:has-text("View Order")');
                            if (viewOrder) {
                                const [popupOrder] = await Promise.all([page.waitForEvent('popup'), viewOrder.click()]);
                                await popupOrder.waitForLoadState('domcontentloaded');

                                await popupOrder.evaluate(() => {
                                    const detailDiv = document.querySelector('#detail');
                                    if (detailDiv) {
                                        detailDiv.style.height = '800px';
                                        detailDiv.style.overflowY = 'visible';
                                    }
                                    document.body.style.zoom = '0.55';
                                });

                                const fullHeight = await popupOrder.evaluate(() => document.body.scrollHeight);
                                await popupOrder.setViewportSize({ width: 1200, height: fullHeight });

                                // create order PDF (Playwright's .pdf writes to disk)
                                await popupOrder.pdf({
                                    path: orderPdfPath,
                                    format: 'A4',
                                    printBackground: true,
                                    scale: 1,
                                    preferCSSPageSize: true
                                });

                                // push order path
                                if (fs.existsSync(orderPdfPath)) {
                                    dosEntry.orderPdfs.push(orderPdfPath);
                                    logPatient(patient, `Order PDF saved: ${orderPdfPath}`);
                                } else {
                                    logPatient(patient, `Order PDF not created for ${collectionDate}`);
                                }

                                await popupOrder.close();
                            } else {
                                logPatient(patient, `No 'View Order' option for ${collectionDate}`);
                            }
                        } catch (err) {
                            logPatient(patient, `Order download error for ${collectionDate}: ${err.message}`);
                        }

                        // ---- MERGE PDFs (if both exist) ---- //
                        try {
                            const haveResult = dosEntry.resultPdfs.length > 0 && fs.existsSync(dosEntry.resultPdfs[dosEntry.resultPdfs.length - 1]);
                            const haveOrder = dosEntry.orderPdfs.length > 0 && fs.existsSync(dosEntry.orderPdfs[dosEntry.orderPdfs.length - 1]);

                            if (haveResult && haveOrder) {
                                const lastResult = dosEntry.resultPdfs[dosEntry.resultPdfs.length - 1];
                                const lastOrder = dosEntry.orderPdfs[dosEntry.orderPdfs.length - 1];

                                await mergePdfs(lastResult, lastOrder, mergedPdfPath);
                                if (fs.existsSync(mergedPdfPath)) {
                                    dosEntry.mergedPdfs.push(mergedPdfPath);
                                    logPatient(patient, `Merged PDF created: ${mergedPdfPath}`);
                                } else {
                                    logPatient(patient, `Merged PDF not found after merge for ${collectionDate}`);
                                }

                                // remove temp result/order files if merged saved
                                try {
                                    if (fs.existsSync(lastResult)) fs.unlinkSync(lastResult);
                                    if (fs.existsSync(lastOrder)) fs.unlinkSync(lastOrder);
                                } catch (e) {
                                    logPatient(patient, `Could not unlink temp files: ${e.message}`);
                                }
                            } else {
                                logPatient(patient, `Skipping merge (result or order missing) for ${collectionDate}`);
                            }
                        } catch (err) {
                            logPatient(patient, `Merge error for ${collectionDate}: ${err.message}`);
                        }

                        // Persist patient updates after handling this row
                        try {
                            patient.dosMatchedCount = patient.files.filter(f => (f.mergedPdfs && f.mergedPdfs.length > 0) || (f.resultPdfs && f.resultPdfs.length > 0) || (f.orderPdfs && f.orderPdfs.length > 0)).length;
                            patient.status = patient.dosMatchedCount > 0 ? 'completed' : patient.status;
                            await saveLogToDb(patient);
                        } catch (err) {
                            logPatient(patient, `DB update error after processing ${collectionDate}: ${err.message}`);
                        }
                    } // end rows loop

                    if (matchedCount === 0) {
                        logPatient(patient, `No matching DOS found for ${patient.ResidentID}`);
                        patient.status = 'no-match';
                        await saveLogToDb(patient);
                    }

                } catch (err) {
                    logPatient(patient, `Error: ${err.message}`);
                    patient.status = 'failed';
                    await saveLogToDb(patient);
                }
            } // end patients loop
        } // end locations loop

        console.log('✅ All patients processed successfully.');
    } catch (err) {
        console.error('❌ Fatal Script Error:', err);
    } finally {
        await mongoose.disconnect();
        console.log('MongoDB disconnected.');
        // await browser.close();
    }
})();
