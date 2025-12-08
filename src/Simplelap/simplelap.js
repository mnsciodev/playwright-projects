// ---------------------- IMPORTS ---------------------- //
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const XLSX = require('xlsx');
const readline = require('readline');
const mongoose = require('mongoose');
const moment = require("moment");

// ---------------------- CONFIG ---------------------- //
const MONGO_URI = 'mongodb://localhost:27017/pcc_labdata'; // change as needed
const baseDir = path.join(__dirname, 'pdf_output');
if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

// ---------------------- SCHEMAS ---------------------- //
const patientSchema = new mongoose.Schema({
    DOB:String,
    Patient:String,
    ResidentID: String,
    dos: String,
    GroupClient: String,
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
    "Member ID#": String,
    dosMatchedCount: { type: Number, default: 0 },
    message: String,
    statusOrder: String,
    messageOrder: String,
    Classification:String,
    Payer:String,
    "Claim#":String,
    Company:String,
    DOS:String,
    "Acct#":String,
    DOB:String,
    "Total Claim Charges":String,
    "Claim Balance":String,
    "Trx Actual Balance":String,

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
async function askExcelFile() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question("📄 Please enter Excel (.xlsx) file path: ", (filePath) => {
            rl.close();
            resolve(filePath.trim());
        });
    });
}
async function importExcelToMongo(filePath) {
    if (!fs.existsSync(filePath)) {
        console.error("❌ Excel file not found:", filePath);
        process.exit(1);
    }

    console.log("📥 Reading Excel:", filePath);

     const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, {
        raw: false,
        dateNF: "yyyy/mm/dd"
    });

    console.log(`📊 ${rows.length} rows found.`);

    const formatted = rows.map(r => ({
        ResidentID: r.ResidentID || r.ResidentId || "",
        dos: r.DOS ? moment(r.DOS, "YYYY/MM/DD").format("M/D/YYYY") : "",
        GroupClient: r.GroupClient || "",
        Client: r.Client || "",
        status: "Pending",
    }));
    await Patient.deleteMany({
        createdAt: {
            $gte: moment().startOf("day").toDate(),
            $lte: moment().endOf("day").toDate()
        },
    });

    await Patient.insertMany(formatted);
    console.log("✅ Excel data inserted into MongoDB!");
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
// ---------------- Retry helper ----------------
async function retryAsync(fn, retries = 3, delayMs = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ Attempt ${attempt} failed: ${err.message}`);
            if (attempt < retries) await new Promise(res => setTimeout(res, delayMs));
        }
    }
    throw lastError;
}

// ---------------- Download Result PDF ----------------
async function downloadResultPdf(page, row, patient, resultPdfPath) {
    try {
        const viewResultsOnclick = await page.evaluate(el => {
            const li = el.querySelector('ul.pccMenuWrapper li[onclick*="viewReportPopup"]');
            return li ? li.getAttribute('onclick') : null;
        }, row);

        if (!viewResultsOnclick) throw new Error('No "View Results" onclick found');

        const paramsMatch = viewResultsOnclick.match(/viewReportPopup\((.+)\)/);
        const params = paramsMatch[1];

        const [popup] = await Promise.all([
            page.waitForEvent('popup', { timeout: 15000 }),
            page.evaluate(`viewReportPopup(${params})`)
        ]);

        await popup.waitForLoadState('domcontentloaded');

        const viewFileBtn = await popup.$('#viewFileButton');
        if (!viewFileBtn) throw new Error("No viewFileButton found");

        const [pdfPopup] = await Promise.all([
            popup.context().waitForEvent('page', { timeout: 15000 }),
            viewFileBtn.click()
        ]);

        await pdfPopup.waitForLoadState('domcontentloaded');

        const pdfUrl = pdfPopup.url();
        const pdfResponse = await page.request.get(pdfUrl);
        const contentType = (pdfResponse.headers()['content-type'] || '').toLowerCase();
        if (!contentType.includes('application/pdf')) throw new Error(`Non-PDF response: ${contentType}`);

        fs.writeFileSync(resultPdfPath, await pdfResponse.body());
        console.log(`✅ Result PDF saved: ${resultPdfPath}`);

        await pdfPopup.close();
        await popup.close();

        await Patient.updateOne({ _id: patient._id }, {
            $set: { status: "success", message: "Result PDF saved", resultPdfs: resultPdfPath }
        });

    } catch (err) {
        console.error(`❌ Result PDF error: ${err.message}`);
        await Patient.updateOne({ _id: patient._id }, {
            $set: { status: "Failed", message: `Result download error: ${err.message}` }
        });
        throw err;
    }
}

// ---------------- Download Order PDF ----------------
async function downloadOrderPdf(page, row, patient, resultPdfPath, orderPdfPath, mergedPdfPath) {
    try {
        const viewOrderOnclick = await page.evaluate(el => {
            const li = el.querySelector('ul.pccMenuWrapper li[onclick*="viewPhysOrder"]');
            return li ? li.getAttribute('onclick') : null;
        }, row);

        if (!viewOrderOnclick) {
            console.log(`ℹ️ No "View Order" found`);
            return;
        }

        const paramsMatch = viewOrderOnclick.match(/viewPhysOrder\((.+)\)/);
        const params = paramsMatch[1];

        const [popupOrder] = await Promise.all([
            page.waitForEvent('popup', { timeout: 15000 }),
            page.evaluate(`viewPhysOrder(${params})`)
        ]);

        await popupOrder.waitForLoadState('domcontentloaded');

        // Adjust layout for PDF
        await popupOrder.evaluate(() => {
            const d = document.querySelector('#detail');
            if (d) { d.style.height = '800px'; d.style.overflowY = 'visible'; }
            document.body.style.zoom = '0.55';
        });

        const fullHeight = await popupOrder.evaluate(() => document.body.scrollHeight);
        await popupOrder.setViewportSize({ width: 1200, height: fullHeight });

        await popupOrder.pdf({ path: orderPdfPath, format: 'A4', printBackground: true });
        await popupOrder.close();

        console.log(`✅ Order PDF saved: ${orderPdfPath}`);

        // Merge PDFs
        await mergePdfs(resultPdfPath, orderPdfPath, mergedPdfPath);

        if (fs.existsSync(mergedPdfPath)) {
            await Patient.updateOne({ _id: patient._id }, {
                $set: {
                    mergedPdfs: mergedPdfPath,
                    statusOrder: "success",
                    messageOrder: "Merged PDF created"
                }
            });
        }

        // Clean up temporary PDFs
        try { fs.existsSync(resultPdfPath) && fs.unlinkSync(resultPdfPath); } catch { }
        try { fs.existsSync(orderPdfPath) && fs.unlinkSync(orderPdfPath); } catch { }

    } catch (err) {
        console.error(`❌ Order PDF error: ${err.message}`);
        await Patient.updateOne({ _id: patient._id }, {
            $set: { statusOrder: "Failed", messageOrder: `Order download error: ${err.message}` }
        });
        throw err;
    }
}

// ---------------------- MAIN SCRIPT ---------------------- //
(async () => {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB");
    
    // 🔹 Step 1: Ask user for Excel
    const excelPath = await askExcelFile();
    
    if (excelPath) {
        console.log("📄 Excel file detected — importing...");
        await importExcelToMongo(excelPath);
        console.log("✅ Excel import completed!");
    } else {
        console.log("⏭️ No Excel file entered — skipping Excel import.");
    }
    console.log("🚀 Starting automation...");
    
    const GroupByClients = await Patient.aggregate(
        [
            { $match: {
                createdAt: {
                    $gte: moment().startOf("day").toDate(),
                    $lte: moment().endOf("day").toDate()
                },
                status: {$nin : ["success","not-found","LoginFailed"]} } 
            },
            {
                $addFields: {
                    MainGroupClient: {
                        $arrayElemAt: [
                            { $split: ["$GroupClient", " "] },
                            0
                        ]
                    }
                }
            },
            {
                $sort: {
                    MainGroupClient: 1,   // Sort by the extracted common client name
                    ResidentId: 1         // Optional (sort inside group)
                }
            },
            {
                $group: {
                    _id: "$MainGroupClient",
                    count: { $sum: 1 },
                    clients: { $addToSet: "$Client" },
                    docs: { $push: "$$ROOT" }
                }
            },

            { $sort: { count: -1 } },
            {
                $project: {
                    _id: 0,
                    GroupClient: "$_id",
                    count: 1,
                    clients: 1,
                    docs: 1
                }
            }
        ]
    );

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
            const Client = GetLocation.GroupClient;
            console.info("User Name:", Client, "| Pending:", count);

            const GetLogin = await Login.findOne({ Client });
            if (!GetLogin) {
                console.error(`❌ No login credentials found for ${Client}`);
                continue;
            }

            // // --- LOGIN ---
            // await page.goto('https://www30.pointclickcare.com/home/login.jsp', { timeout: 60000 });
            // await page.fill('[name="un"]', GetLogin.UserName);
            // await page.click('#id-next');
            // await page.waitForSelector('[data-test="login-password-input"]', { state: 'visible', timeout: 20000 });
            // await page.fill('[data-test="login-password-input"]', GetLogin.Password);
            // await page.click('[data-test="login-signIn-button"]');

            // try {
            //     await page.waitForSelector('[data-test="mfa-setup-info-later-button"]', { timeout: 8000 });
            //     console.log('⚙️ MFA setup detected — skipping...');
            //     await page.click('[data-test="mfa-setup-info-later-button"]');
            // } catch { }

            // --- MANUAL LOGIN REQUIRED (MFA Compatible) ---
            console.log("\n🔑 *** MANUAL LOGIN REQUIRED ***");

            await page.goto('https://www30.pointclickcare.com/home/login.jsp', { timeout: 60000 });
            await page.fill('[name="un"]', GetLogin.UserName);
            await page.click('#id-next');
            await page.waitForSelector('[data-test="login-password-input"]', { state: 'visible', timeout: 20000 });
            await page.fill('[data-test="login-password-input"]', GetLogin.Password);
            // ✅ Wait until dashboard link appears (means login completed)
            try {
                await page.waitForSelector('#pccFacLink', { timeout: 0 }); // wait until logged in
            } catch (err) {
                console.log("❌ Login failed or browser window closed. Exiting...");
                await browser.close();
                await mongoose.disconnect();
                process.exit();
            }
            console.log("✅ Login successful! Continuing...\n");


            // for (const facilityName of GetLocation.clients) {

            //     await page.waitForSelector('#pccFacLink', { state: 'visible', timeout: 60000 });
            //     console.log('✅ Dashboard loaded successfully.');

            //     await retryClick(page, '#pccFacLink');
            //     await page.waitForTimeout(5000);

            //     const selected = await selectFacilityWithRetry(page, facilityName);
            //     if (!selected) {
            //         console.error(`🚫 Skipping facility: ${facilityName}`);
            //         continue;
            //     }

            await page.waitForSelector('#searchField', { state: 'visible', timeout: 60000 });
            await page.waitForTimeout(3000);

            let lastResident = "";

            for (const patient of GetLocation.docs) {
                try {
                    console.info(`👤 Processing: ${patient.ResidentID} | DOS: ${patient.dos}`);

                    if (lastResident !== patient.ResidentID) {
                        lastResident = patient.ResidentID;


                        await page.fill('#searchField', patient.ResidentID);
                        // 1️⃣ Make #searchAll visible if it's hidden
                        await page.evaluate(() => {
                            const searchAll = document.querySelector('#searchAll');
                            if (searchAll) {
                                searchAll.style.display = 'block';
                            }
                        });

                        // 2️⃣ Click the "All Facilities" row
                        await page.click('#searchAll tr:has-text("All Facilities")');


                        // CLICK that triggers popup is inside retrySubmitSearch,
                        // so wrap it in Promise.all
                        // Press Enter to trigger search → popup opens
                        const [globalPopup] = await Promise.all([
                            page.waitForEvent('popup', { timeout: 15000 }),
                            page.press('#searchField', 'Enter')   // replaces retrySubmitSearch(page)
                        ]);
                        await globalPopup.waitForLoadState('domcontentloaded');

                        await globalPopup.waitForSelector('table.pccTableShowDivider', { timeout: 10000 });

                        // Click the correct resident link by ResidentID match
                        const selector = `a:has-text("(${patient.ResidentID})")`;
                        await globalPopup.waitForSelector(selector, { timeout: 5000 });

                        // Try clicking and wait up to 4 seconds for popup to close
                        try {
                            await Promise.race([
                                globalPopup.click(selector),
                                (async () => { await new Promise(r => setTimeout(r, 4000)); })()
                            ]);
                        } catch (err) {
                            console.log("Click failed or timed out:", err);
                        }

                        // 5) Ensure popup is closed (failsafe)
                        // try {
                        //     await globalPopup.close();
                        // } catch { }

                        // // 6) Wait until main page loads the resident’s page
                        // await page.waitForLoadState('networkidle', { timeout: 20000 });
                        // console.log("✅ Resident profile loaded");

                        // lastResident = patient.ResidentID;
                        // await page.fill('#searchField', patient.ResidentID);
                        // await retrySubmitSearch(page);
                        await page.waitForTimeout(5000);

                        try {
                            await page.waitForSelector('a[href*="labResults.xhtml"]', { state: 'visible', timeout: 10000 });
                            await page.click('a[href*="labResults.xhtml"]');
                            console.log('✅ Navigated to lab results page.');

                            // Wait for the page to load and check if the error page is displayed
                            await page.waitForTimeout(3000); // Wait for any potential error page to load

                            const errorPage = await page.evaluate(() => {
                                const errorMessage = document.querySelector('h2')?.textContent;
                                return errorMessage?.includes('An error occurred while loading the page');
                            });

                            if (errorPage) {
                                console.warn("⚠️ Lab Results page failed to load, going back...");
                                await page.goBack(); // Simulate going back to the previous page
                                console.log("✅ Returned to the previous page.");
                            }
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
                        try {
                            const collectionDate = await row.$eval('td:nth-child(6) span', el => el.textContent.trim());
                            if (!collectionDate.includes(patient.dos)) continue;

                            matchedCount++;

                            const cleanDate = collectionDate.replace(/[/: ]/g, '_');
                            const ts = Date.now();
                            const resultPdfPath = path.join(baseDir, `${Client}_${patient.ResidentID}_Result_${cleanDate}_${ts}.pdf`);
                            const orderPdfPath = path.join(baseDir, `${Client}_${patient.ResidentID}_Order_${cleanDate}_${ts}.pdf`);
                            const mergedPdfPath = path.join(baseDir, `${Client}_${patient.ResidentID}_Merged_${cleanDate}_${ts}.pdf`);

                            // ---------- RESULT PDF ----------
                            await retryAsync(() => downloadResultPdf(page, row, patient, resultPdfPath), 3, 5000);

                            // ---------- ORDER PDF ----------
                            await retryAsync(() => downloadOrderPdf(page, row, patient, resultPdfPath, orderPdfPath, mergedPdfPath), 3, 5000);

                        } catch (err) {
                            console.error(`❌ Failed after retries for patient ${patient.ResidentID}: ${err.message}`);
                            await Patient.updateOne({ _id: patient._id }, {
                                $set: { status: "Failed", message: `Failed after retries: ${err.message}` }
                            });
                        }
                    }
                    const UpdateData = {
                        dosMatchedCount: matchedCount,
                        ...(matchedCount === 0
                            ? { status: "Failed", message: "No matching DOS found" }
                            : {})
                    };

                    await Patient.updateOne(
                        { _id: patient._id },
                        { $set: UpdateData }
                    );


                } catch (err) {
                    console.error("❌ Patient processing error:", err.message);
                    await Patient.updateOne({ _id: patient._id }, {
                        $set: { status: "Failed", message: `Error: ${err.message}` }
                    });
                }
                //}
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
