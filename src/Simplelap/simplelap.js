// ---------------------- IMPORTS ---------------------- //
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
    resultPdfs: String,
    orderPdfs: String,
    mergedPdfs: String,
    files: [
        {
            dos: String,
            resultPdfs: [String],
            orderPdfs: [String],
            mergedPdfs: [String],
        }
    ],
    dosMatchedCount: { type: Number, default: 0 },
    message: String,
    statusOrder :String,
    messageOrder : String
}, { timestamps: true });

const Patient = mongoose.model('patients', patientSchema);
const LogsSchema = new mongoose.Schema({
    Client: String,
    UserName: String,
    Password: String
});
const Login = mongoose.model('logins', LogsSchema);

// ---------------------- HELPERS ---------------------- //
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

async function retrySubmitSearch(page, maxRetries = 3, delay = 1500) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await page.evaluate(() => {
                if (typeof submitSearchNew === 'function') submitSearchNew();
                else throw new Error('submitSearchNew not defined');
            });
            console.log(`✅ submitSearchNew() executed (attempt ${attempt})`);
            return;
        } catch (err) {
            console.warn(`⚠️ Attempt ${attempt} failed: ${err.message}`);
            if (attempt < maxRetries) await page.waitForTimeout(delay);
            else throw new Error('❌ Failed to execute submitSearchNew() after retries');
        }
    }
}

async function retryClick(page, selector, maxRetries = 5, delay = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await page.click(selector, { timeout: 2000 });
            console.log(`Click successful on attempt ${attempt}`);
            return;
        } catch (error) {
            console.warn(`Attempt ${attempt} failed: ${error.message}`);
            if (attempt < maxRetries) await page.waitForTimeout(delay);
            else throw new Error(`Failed to click ${selector} after ${maxRetries} attempts`);
        }
    }
}

async function selectFacilityWithRetry(page, facilityName, maxRetries = 3, delay = 4000) {
    const normalizedName = facilityName
        .replace(/\b(of|the|care)\b/gi, '')
        .replace(/\s+/g, '.*')
        .trim();
    const regex = new RegExp(normalizedName, 'i');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🔍 Attempt ${attempt}: Selecting facility "${facilityName}"...`);

            await page.click('#pccFacLink', { timeout: 5000 });
            await page.waitForSelector('ul#optionList a', { state: 'visible', timeout: 10000 });

            const facilityLocator = page.locator('ul#optionList a', { hasText: regex });
            const count = await facilityLocator.count();
            if (count === 0) throw new Error(`No match found for "${facilityName}"`);

            await Promise.all([
                facilityLocator.first().click({ timeout: 8000 }),
                page.waitForTimeout(1500)
            ]);

            await Promise.race([
                page.waitForSelector('#searchField', { state: 'visible', timeout: 15000 }),
                page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => { })
            ]);

            console.log(`✅ Successfully selected facility: ${facilityName}`);
            return true;

        } catch (error) {
            console.warn(`⚠️ Attempt ${attempt} failed for "${facilityName}": ${error.message}`);

            if (attempt === maxRetries) {
                console.error(`❌ Failed to select facility "${facilityName}"`);
                return false;
            }

            console.log(`⏳ Retrying in ${delay / 1000}s...`);
            await page.waitForTimeout(delay);
        }
    }
}

// ---------------------- MAIN SCRIPT ---------------------- //
(async () => {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB");

    const GroupByClients = await Patient.aggregate([
        {
            $match: { status: "Pending" }
        },
        {
            $group: {
                _id: {
                    Client: "$Client",         // Group by Client
                    ResidentId: "$ResidentId"  // and ResidentId
                },
                count: { $sum: 1 },          // Count documents per (Client + ResidentId)
                docs: { $push: "$$ROOT" }    // Push full documents into an array
            }
        },
        {
            $sort: {
                "count": -1,
            }
        }
    ]);

    if (GroupByClients.length === 0) {
        console.log('No Pending patients found in database.');
        await mongoose.disconnect();
        return;
    }

    const browser = await chromium.launch({ headless: false, channel: 'chrome' });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        for (const GetLocation of GroupByClients) {
            const count = GetLocation.count;
            const facilityName = GetLocation._id.Client;
            console.info("🏥 Facility:", facilityName, "| Pending:", count);

            const GetLogin = await Login.findOne({ Client: facilityName });
            if (!GetLogin) {
                console.error(`❌ No login credentials found for ${facilityName}`);
                continue;
            }

            // --- LOGIN ---
            await page.goto('https://www30.pointclickcare.com/home/login.jsp', { timeout: 60000 });
            await page.fill('[name="un"]', GetLogin.UserName);
            await page.click('#id-next');
            await page.waitForSelector('[data-test="login-password-input"]', { state: 'visible', timeout: 20000 });
            await page.fill('[data-test="login-password-input"]', GetLogin.Password);
            await page.click('[data-test="login-signIn-button"]');

            try {
                await page.waitForSelector('[data-test="mfa-setup-info-later-button"]', { timeout: 8000 });
                console.log('⚙️ MFA setup detected — skipping...');
                await page.click('[data-test="mfa-setup-info-later-button"]');
            } catch { }

            await page.waitForSelector('#pccFacLink', { state: 'visible', timeout: 60000 });
            console.log('✅ Dashboard loaded successfully.');

            await retryClick(page, '#pccFacLink');
            await page.waitForTimeout(5000);

            const selected = await selectFacilityWithRetry(page, facilityName);
            if (!selected) {
                console.error(`🚫 Skipping facility: ${facilityName}`);
                continue;
            }

            await page.waitForSelector('#searchField', { state: 'visible', timeout: 60000 });
            await page.waitForTimeout(3000);

            let lastResident = "";

            for (const patient of GetLocation.docs) {
                try {
                    console.info(`👤 Processing: ${patient.ResidentID} | DOS: ${patient.dos}`);

                    if (lastResident !== patient.ResidentID) {
                        lastResident = patient.ResidentID;
                        await page.fill('#searchField', patient.ResidentID);
                        await retrySubmitSearch(page);
                        await page.waitForTimeout(3000);

                        try {
                            await page.waitForSelector('a[href*="labResults.xhtml"]', { state: 'visible', timeout: 10000 });
                            await page.click('a[href*="labResults.xhtml"]');
                            console.log('✅ Navigated to lab results page.');
                        } catch {
                            console.warn(`⚠️ Lab Results not found for ${patient.ResidentID}`);
                            await Patient.updateOne({ _id: patient._id }, {
                                $set: { status: "not-found", message: "Lab Results not available" }
                            });
                            continue;
                        }

                        await page.waitForSelector('#filterTrigger', { state: 'visible', timeout: 30000 });

                        // ---- Expand Display Filters (if needed) ----
                        try {
                            const filterImg = await page.$('#filterTrigger img.plussign_img');
                            if (filterImg) {
                                const src = await filterImg.getAttribute('src');
                                if (src && src.includes('newplus.gif')) {
                                    console.log('⚙️ Filters collapsed — expanding...');

                                    // Retry click up to 3 times
                                    for (let attempt = 1; attempt <= 3; attempt++) {
                                        try {
                                            await page.click('#filterTrigger', { timeout: 5000 });
                                            // Wait for either the image OR the panel to be visible
                                            const expanded = await Promise.race([
                                                page.waitForFunction(() => {
                                                    const img = document.querySelector('#filterTrigger img.plussign_img');
                                                    return img && img.src.includes('newminus.gif');
                                                }, { timeout: 8000 }).then(() => true).catch(() => false),
                                                page.waitForSelector('#filterForm, .filtersPanel, .filterContent', { state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)
                                            ]);

                                            if (expanded) {
                                                console.log('✅ Filters expanded successfully.');
                                                break;
                                            } else if (attempt === 3) {
                                                console.warn('⚠️ Filters did not expand after 3 attempts — continuing anyway.');
                                            } else {
                                                console.log(`↪️ Retry ${attempt} failed, waiting 2s before retry...`);
                                                await page.waitForTimeout(2000);
                                            }
                                        } catch (clickErr) {
                                            console.warn(`⚠️ Attempt ${attempt} to expand filters failed: ${clickErr.message}`);
                                            await page.waitForTimeout(2000);
                                        }
                                    }
                                } else {
                                    console.log('✅ Filters already expanded.');
                                }
                            } else {
                                console.log('ℹ️ Filter icon not found — continuing without expanding.');
                            }
                        } catch (err) {
                            console.warn(`⚠️ Error expanding filters: ${err.message} — continuing script.`);
                        }
                        await page.fill('#reported_date_dummy', '');
                        await page.fill('#collection_date_dummy', '');
                        await page.click('#refreshButtonId');
                    }

                    // Wait for results
                    let tableFound = false;
                    let rows = [];
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            await page.waitForSelector('#resultsTable', { state: 'visible', timeout: 20000 });
                            rows = await page.$$('#resultsTable tbody tr');
                            if (rows.length > 0) { tableFound = true; break; }
                            await page.click('#refreshButtonId');
                            await page.waitForTimeout(2000);
                        } catch {
                            await page.waitForTimeout(2000);
                        }
                    }

                    if (!tableFound) {
                        await Patient.updateOne({ _id: patient._id }, {
                            $set: { status: "no-results", message: "No lab results found." }
                        });
                        continue;
                    }

                    let matchedCount = 0;

                    for (const row of rows) {
                        const collectionDate = await row.$eval('td:nth-child(6) span', el => el.textContent.trim());
                        if (!collectionDate.includes(patient.dos)) continue;

                        matchedCount++;
                        const cleanDate = collectionDate.replace(/[/: ]/g, '_');
                        const ts = Date.now();
                        const resultPdfPath = path.join(baseDir, `${facilityName}_${patient.ResidentID}_Result_${cleanDate}_${ts}.pdf`);
                        const orderPdfPath = path.join(baseDir, `${facilityName}_${patient.ResidentID}_Order_${cleanDate}_${ts}.pdf`);
                        const mergedPdfPath = path.join(baseDir, `${facilityName}_${patient.ResidentID}_Merged_${cleanDate}_${ts}.pdf`);

                        // ---- RESULT PDF ----
                        try {
                            const actionsMenu = await row.$('a.pccActionMenu');
                            await actionsMenu.click();
                            const viewResults = await row.$('li:has-text("View Results")');

                            if (viewResults) {
                                const [popup] = await Promise.all([
                                    page.waitForEvent('popup', { timeout: 10000 }),
                                    viewResults.click()
                                ]).catch(() => []);
                                if (!popup) throw new Error("No popup appeared for View Results");

                                await popup.waitForLoadState('domcontentloaded');
                                const viewFileBtn = await popup.$('#viewFileButton');
                                if (viewFileBtn) {
                                    const [pdfPopup] = await Promise.all([
                                        popup.context().waitForEvent('page', { timeout: 10000 }),
                                        viewFileBtn.click()
                                    ]).catch(() => []);
                                    if (!pdfPopup) throw new Error("PDF popup not found");

                                    await pdfPopup.waitForLoadState('domcontentloaded');
                                    const pdfUrl = pdfPopup.url();
                                    const pdfResponse = await page.request.get(pdfUrl);
                                    const contentType = (pdfResponse.headers()['content-type'] || '').toLowerCase();

                                    if (contentType.includes('application/pdf')) {
                                        fs.writeFileSync(resultPdfPath, await pdfResponse.body());
                                        await Patient.updateOne({ _id: patient._id }, {
                                            $set: { status: "success", message: "Result PDF Saved", resultPdfPath }
                                        });
                                    } else {
                                        throw new Error(`Non-PDF response: ${contentType}`);
                                    }

                                    await pdfPopup.close();
                                }
                                await popup.close();
                            }
                        } catch (err) {
                            await Patient.updateOne({ _id: patient._id }, {
                                $set: { status: "Failed", message: `Result download error: ${err.message}` }
                            });
                            continue;
                        }

                        // ---- ORDER PDF ----
                        try {
                            console.log(`🧾 Downloading order for ${collectionDate}...`);
                            const actionMenuLocator = await row.$('a.pccActionMenu');
                            await actionMenuLocator.click({ timeout: 5000 });

                            const viewOrderLocator = row.$('li:has-text("View Results")');
                            if (viewOrderLocator) {
                                console.log(`ℹ️ No "View Order" found`);
                                continue;
                            }

                            const [popupOrder] = await Promise.all([
                                page.waitForEvent('popup', { timeout: 10000 }),
                                viewOrderLocator.click()
                            ]).catch(() => []);
                            if (!popupOrder) throw new Error("No popup appeared for View Order");

                            await popupOrder.waitForLoadState('domcontentloaded');
                            await popupOrder.evaluate(() => {
                                const d = document.querySelector('#detail');
                                if (d) { d.style.height = '800px'; d.style.overflowY = 'visible'; }
                                document.body.style.zoom = '0.55';
                            });
                            const fullHeight = await popupOrder.evaluate(() => document.body.scrollHeight);
                            await popupOrder.setViewportSize({ width: 1200, height: fullHeight });
                            await popupOrder.pdf({ path: orderPdfPath, format: 'A4', printBackground: true });
                            await popupOrder.close();

                            if (fs.existsSync(orderPdfPath)) {
                                console.log(`✅ Order PDF saved`);
                                await mergePdfs(resultPdfPath, orderPdfPath, mergedPdfPath);

                                if (fs.existsSync(mergedPdfPath)) {
                                    await Patient.updateOne({ _id: patient._id }, {
                                        $set: { mergedPdfs: mergedPdfPath, statusOrder: "success", messageOrder: "Merged PDF created" }
                                    });
                                }
                            }

                            // Cleanup safely
                            try { if (fs.existsSync(resultPdfPath)) fs.unlinkSync(resultPdfPath); } catch { }
                            try { if (fs.existsSync(orderPdfPath)) fs.unlinkSync(orderPdfPath); } catch { }

                        } catch (err) {
                            console.error("❌ Order download error:", err.message);
                            await Patient.updateOne({ _id: patient._id }, {
                                $set: { statusOrder: "Failed", messageOrder: `Order download error: ${err.message}` }
                            });
                        }
                    }

                    if (matchedCount === 0) {
                        await Patient.updateOne({ _id: patient._id }, {
                            $set: { status: "Failed", message: "No matching DOS found" }
                        });
                    }

                } catch (err) {
                    console.error("❌ Patient processing error:", err.message);
                    await Patient.updateOne({ _id: patient._id }, {
                        $set: { status: "Failed", message: `Error: ${err.message}` }
                    });
                }
            }
        }

        console.log('✅ All patients processed successfully.');
    } catch (err) {
        console.error('❌ Fatal Script Error:', err);
    } finally {
        await mongoose.disconnect();
        // await browser.close();
        console.log('🔒 MongoDB disconnected & browser closed.');
    }
})();
