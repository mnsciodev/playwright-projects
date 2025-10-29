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
    account: String,
    dos: String,
    Client: String,
    status: { type: String, default: 'Pending' },
    logs: [String],
    files: {
        resultPdf: String,
        orderPdf: String,
        mergedPdf: String
    }
});

const Patient = mongoose.model('patients', patientSchema);

// ---------------------- HELPER FUNCTIONS ---------------------- //
function logPatient(patient, msg) {
    patient.logs.push(`${new Date().toISOString()} - ${msg}`);
    console.log(`🩺 [${patient.account}] ${msg}`);
}

async function saveLogToDb(patient) {
    await patient.save().catch(err => console.error(`DB Save Error: ${err.message}`));
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
    console.log('Connected to MongoDB');

    const GroupByClients = await Patient.aggregate([{
        $match: {status:{$ne:"completed"}}
    },
    {
        $group: {
            _id: "$Client",
        }
    }])

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
            const facilityName = GetLocation._id; // "BRIA OF BELLEVILLE"
            await page.click('#pccFacLink');

            await page.waitForSelector('#optionList li', { state: 'visible' });
            console.log("facilityName", facilityName)

            const facilityLocator = page.locator('ul#optionList a', {
                hasText: new RegExp(`^${facilityName.trim()}.*`, 'i') // .* matches anything after
            });

            await facilityLocator.waitFor({ state: 'visible', timeout: 10000 });
            await facilityLocator.click();

            // Optional: wait for the page to load after switching
            await page.waitForLoadState('networkidle');

            const patients = await Patient.find({ status:{$ne:"completed"}, Client: facilityName });
            await page.waitForTimeout(3000)
            // --- LOOP THROUGH DB PATIENTS ---
            for (const patient of patients) {
                logPatient(patient, `Processing DOS ${patient.dos}`);

                try {
                    // --- SEARCH RESIDENT ---
                    await page.fill('#searchField', patient.account);
                    await Promise.all([
                        page.keyboard.press('Enter'),
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { })
                    ]);

                    // --- LAB RESULTS TAB ---
                    await page.click('a[href*="labResults.xhtml"]');
                    await page.waitForSelector('#filterTrigger', { state: 'visible', timeout: 30000 });

                    // --- EXPAND FILTERS ---
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

                    // --- REFRESH RESULTS ---
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

                    let found = false;
                    for (const row of rows) {
                        const collectionDate = await row.$eval('td:nth-child(6) span', el => el.textContent.trim());
                        if (collectionDate.includes(patient.dos)) {
                            found = true;
                            logPatient(patient, `Found DOS: ${collectionDate}`);

                            const cleanDate = collectionDate.replace(/[/: ]/g, '_');
                            const resultPdfPath = path.join(baseDir, `${patient.account}_Results_${cleanDate}.pdf`);
                            const orderPdfPath = path.join(baseDir, `${patient.account}_Order_${cleanDate}.pdf`);
                            const mergedPdfPath = path.join(baseDir, `${patient.account}_Merged_${cleanDate}.pdf`);

                            // --- VIEW RESULTS POPUP ---
                            const actionsMenu = await row.$('a.pccActionMenu');
                            await actionsMenu.click();
                            const viewResults = await row.$('li:has-text("View Results")');
                            const [popup] = await Promise.all([page.waitForEvent('popup'), viewResults.click()]);
                            await popup.waitForLoadState('domcontentloaded');

                            // --- Wait for the popup to open on clicking the button ---
                            const viewFileBtn = await popup.$('#viewFileButton');
                            if (viewFileBtn) {
                                // Listen for the new page that opens (popup)
                                const [pdfPopup] = await Promise.all([
                                    popup.context().waitForEvent('page'), // wait for new popup
                                    viewFileBtn.click()                    // trigger popup
                                ]);

                                await pdfPopup.waitForLoadState('domcontentloaded');

                                // Now you have the actual URL of the popup
                                const pdfUrl = pdfPopup.url();
                                console.log('Dynamic PDF URL:', pdfUrl);

                                // You can now fetch it directly if needed
                                const pdfResponse = await page.request.get(pdfUrl);
                                const contentType = pdfResponse.headers()['content-type'];
                                if (contentType !== 'application/pdf') {
                                    throw new Error(`Expected PDF, got ${contentType}`);
                                }

                                fs.writeFileSync(resultPdfPath, await pdfResponse.body());
                                patient.files.resultPdf = resultPdfPath;
                                logPatient(patient, `Result PDF saved`);

                                await pdfPopup.close();
                            }
                            await popup.close();

                            // --- VIEW ORDER POPUP ---
                            const actionsMenuOrder = await row.$('a.pccActionMenu');
                            await actionsMenuOrder.click();
                            const viewOrder = await row.$('li:has-text("View Order")');
                            if (viewOrder) {
                                const [popupOrder] = await Promise.all([page.waitForEvent('popup'), viewOrder.click()]);
                                await popupOrder.waitForLoadState('domcontentloaded');
                                const scheduleButton = popupOrder.locator('#scheduleDetailsBar');
                                if (await scheduleButton.isVisible()) await scheduleButton.click();
                                await popupOrder.waitForTimeout(1000);

                                await popupOrder.pdf({ path: orderPdfPath, format: 'A4', printBackground: true });
                                patient.files.orderPdf = orderPdfPath;
                                logPatient(patient, `Order PDF saved`);
                                await popupOrder.close();
                            }
                            console.log("patient",)
                            // --- MERGE PDFs ---
                            if (patient.files.resultPdf && patient.files.orderPdf) {
                                await mergePdfs(resultPdfPath, orderPdfPath, mergedPdfPath);
                                patient.files.mergedPdf = mergedPdfPath;
                                logPatient(patient, `Merged PDF created`);
                                fs.unlinkSync(resultPdfPath);
                                fs.unlinkSync(orderPdfPath);
                            }

                            patient.status = 'completed';
                            break;
                        }
                    }

                    if (!found) {
                        logPatient(patient, `No matching DOS found for ${patient.account}`);
                        patient.status = 'no-match';
                    }

                } catch (err) {
                    logPatient(patient, `Error: ${err.message}`);
                    patient.status = 'failed';
                }
                await saveLogToDb(patient);
            }
        }
        console.log('All patients processed successfully.');
    } catch (err) {
        console.error('Fatal Script Error:', err);
    } finally {
        await mongoose.disconnect();
        console.log('MongoDB disconnected.');
        //await browser.close();
    }
})();