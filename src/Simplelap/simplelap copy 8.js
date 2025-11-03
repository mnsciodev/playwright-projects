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
    message: String
}, {
    timestamps: true
});

const Patient = mongoose.model('patients', patientSchema);
const LogsSchema = new mongoose.Schema({
    Client: String,
    UserName: String,
    Password: String
});

const Login = mongoose.model('logins', LogsSchema);

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
                if (typeof submitSearchNew === 'function') {
                    submitSearchNew();
                } else {
                    throw new Error('submitSearchNew not defined yet');
                }
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
            if (attempt < maxRetries) {
                await page.waitForTimeout(delay); // wait before retry
            } else {
                throw new Error(`Failed to click ${selector} after ${maxRetries} attempts`);
            }
        }
    }
}
async function selectFacilityWithRetry(page, facilityName, maxRetries = 3, delay = 4000) {
    const normalizedName = facilityName
        .replace(/\b(of|the|care)\b/gi, '') // remove filler words
        .replace(/\s+/g, '.*')              // allow flexible spaces
        .trim();

    const regex = new RegExp(normalizedName, 'i');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🔍 Attempt ${attempt}: Selecting facility "${facilityName}"...`);

            // Always re-open dropdown in case it's closed
            await page.click('#pccFacLink', { timeout: 5000 });
            await page.waitForSelector('ul#optionList', { state: 'visible', timeout: 10000 });
            await page.waitForSelector('ul#optionList a', { state: 'visible', timeout: 10000 });

            const facilityLocator = page.locator('ul#optionList a', { hasText: regex });
            const count = await facilityLocator.count();
            if (count === 0) throw new Error(`No match found for "${facilityName}"`);

            // Try clicking it
            await Promise.all([
                facilityLocator.first().click({ timeout: 8000 }),
                page.waitForTimeout(1500) // let AJAX start
            ]);

            // Wait for page transition after facility selection
            await Promise.race([
                page.waitForSelector('#searchField', { state: 'visible', timeout: 15000 }),
                page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => { })
            ]);

            console.log(`✅ Successfully selected facility: ${facilityName}`);
            return true;

        } catch (error) {
            console.warn(`⚠️ Attempt ${attempt} failed for "${facilityName}": ${error.message}`);

            if (attempt === maxRetries) {
                console.log(`🔍 Trying fallback for "${facilityName}"...`);
                try {
                    await page.click('#pccFacLink', { timeout: 5000 });
                    await page.waitForSelector('ul#optionList a', { state: 'visible', timeout: 10000 });

                    const allFacilities = await page.locator('ul#optionList a').allTextContents();
                    const fallback = allFacilities.find(opt =>
                        opt.toLowerCase().includes(
                            facilityName.toLowerCase().replace(/\b(of|the|care)\b/g, '').trim()
                        )
                    );

                    if (fallback) {
                        console.log(`🔄 Fallback matched: ${fallback}`);
                        await Promise.all([
                            page.locator(`ul#optionList a:has-text("${fallback}")`).first().click(),
                            page.waitForTimeout(1500)
                        ]);

                        await page.waitForSelector('#searchField', { state: 'visible', timeout: 15000 });
                        console.log(`✅ Fallback selection successful: ${fallback}`);
                        return true;
                    } else {
                        console.error(`❌ No facility found for ${facilityName}`);
                        return false;
                    }
                } catch (fallbackErr) {
                    console.error(`❌ Fallback selection failed: ${fallbackErr.message}`);
                    return false;
                }
            }

            console.log(`⏳ Retrying in ${delay / 1000}s...`);
            await page.waitForTimeout(delay);
        }
    }

    console.error(`❌ Failed to select facility "${facilityName}" after ${maxRetries} attempts.`);
    return false;
}

// ---------------------- MAIN SCRIPT ---------------------- //
(async () => {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB");

    const GroupByClients = await Patient.aggregate(
        [
            {
                $match: { status: "Pending" }
            },
            {
                $group: {
                    _id: {
                        Client: "$Client",         // Group by Client
                        ResidentID: "$ResiResidentIDdentId"  // and ResidentID
                    },
                    count: { $sum: 1 },          // Count documents per (Client + ResidentID)
                    docs: { $push: "$$ROOT" }    // Push full documents into an array
                }
            },
            {
                $sort: {
                    "count": -1,
                }
            }
        ]
    );

    if (GroupByClients.length === 0) {
        console.log('No Pending patients found in database.');
        return;
    }

    const browser = await chromium.launch({ headless: false, channel: 'chrome' });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {

        for (const GetLocation of GroupByClients) {
            const count = GetLocation.count;
            const facilityName = GetLocation._id.Client;
            console.info("facilityName", facilityName, count)
            // --- LOGIN ---
            var GetLogin = await Login.findOne({ Client: facilityName })
            await page.goto('https://www30.pointclickcare.com/home/login.jsp', { timeout: 60000 });
            await page.fill('[name="un"]', GetLogin.UserName);
            await page.click('#id-next');
            await page.waitForSelector('[data-test="login-password-input"]', { state: 'visible', timeout: 20000 });
            await page.fill('[data-test="login-password-input"]', GetLogin.Password);
            await page.click('[data-test="login-signIn-button"]');

            try {
                // Wait briefly to see if MFA setup appears
                await page.waitForSelector('[data-test="mfa-setup-info-later-button"]', { timeout: 10000 });
                console.log('⚙️ MFA setup page detected — clicking "SET UP LATER"...');
                await page.click('[data-test="mfa-setup-info-later-button"]');
                // Wait for dashboard (instead of networkidle, which never resolves)

            } catch (e) {
                console.log('✅ MFA setup page not detected — continuing normally.');
            }
            console.log('⏳ Waiting for main dashboard to appear...');
            await page.waitForSelector('#pccFacLink', { state: 'visible', timeout: 60000 });

            console.log('✅ Dashboard loaded successfully.');
            //await page.waitForSelector('#searchField', { state: 'visible', timeout: 60000 });


            // Usage
            await retryClick(page, '#pccFacLink');

            await page.waitForTimeout(10000);

            const selected = await selectFacilityWithRetry(page, facilityName, 3, 3000);
            if (!selected) {
                console.error(`🚫 Skipping facility: ${facilityName}`);
                continue; // move to next client
            }

            console.log(`🎯 ${facilityName} loaded successfully.`);

            await page.waitForSelector('#searchField', { state: 'visible', timeout: 60000 });

            await page.waitForTimeout(3000);
            var CheckSamePatient = ""
            for (const patient of GetLocation.docs) {
                try {
                    console.info("patient", patient.ResidentID, patient.dos)
                    if(CheckSamePatient != patient.ResidentID){

                    
                    await page.fill('#searchField', patient.ResidentID);
                    await retrySubmitSearch(page);
                    await page.waitForTimeout(3000);

                    try {
                        // Try to click the "Lab Results" link
                        await page.waitForSelector('a[href*="labResults.xhtml"]', { state: 'visible', timeout: 10000 });
                        await page.click('a[href*="labResults.xhtml"]');
                        console.log('✅ Navigated to lab results page.');
                    } catch (err) {
                        console.warn(`⚠️ Lab Results link not found for ${patient.ResidentID} — marking as not found.`);

                        // Update MongoDB to record the failure
                        await Patient.updateOne(
                            { _id: patient._id },
                            {
                                $set: {
                                    status: "not-found",
                                    message: "Lab Results link not available for this resident."
                                }
                            }
                        );

                        // Skip to the next patient
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
                    let tableFound = false;
                    let rows = []
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            console.log(`Attempt ${attempt}: waiting for results table...`);

                            await page.waitForSelector('#resultsTable', { state: 'visible', timeout: 20000 });

                            rows = await page.$$('#resultsTable tbody tr');
                            console.log("rows.length", rows.length);

                            if (rows.length > 0) {
                                tableFound = true;
                                break; // ✅ Success — exit loop
                            } else {
                                console.log("No rows found, retrying...");
                                await page.click('#refreshButtonId'); // or the button that reloads results
                                await page.waitForTimeout(3000);
                            }

                        } catch (err) {
                            console.log(`Attempt ${attempt} failed:`, err.message);
                            await page.click('#refreshButtonId'); // try refreshing
                            await page.waitForTimeout(3000);
                        }
                    }

                    if (!tableFound) {
                        console.log("tableFound", "no-results")
                        await Patient.updateOne(
                            { _id: patient._id },
                            {
                                $set: {
                                    status: "no-results",
                                    message: "No lab results found after multiple retries."
                                }
                            }
                        );
                        continue;
                    }
                    } else {
                        CheckSamePatient = patient.ResidentID
                    }

                    let matchedCount = 0;

                    for (const row of rows) {
                        const collectionDate = await row.$eval('td:nth-child(6) span', el => el.textContent.trim());

                        if (collectionDate.includes(patient.dos)) {
                            console.log("Matched Date", collectionDate)
                            matchedCount++;
                            const cleanDate = collectionDate.replace(/[/: ]/g, '_');
                            const ts = Date.now();
                            const resultPdfPath = path.join(baseDir, `${facilityName}_${patient.ResidentID}_Result_${cleanDate}_${ts}.pdf`);
                            const orderPdfPath = path.join(baseDir, `${facilityName}_${patient.ResidentID}_Order_${cleanDate}_${ts}.pdf`);
                            const mergedPdfPath = path.join(baseDir, `${facilityName}_${patient.ResidentID}_Merged_${cleanDate}_${ts}.pdf`);

                            // Ensure patient.files exists (safety)
                            if (!Array.isArray(patient.files)) patient.files = [];

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

                                            await Patient.updateOne({ _id: patient._id }, {
                                                $set: {
                                                    status: "success",
                                                    message: "Result PDF Saved",
                                                    resultPdfPath: resultPdfPath
                                                }
                                            })


                                        } else {
                                            await Patient.updateOne({ _id: patient._id }, {
                                                $set: {
                                                    status: "Failed",
                                                    message: `Skipped non-PDF result (content-type: ${contentType}) for ${collectionDate}`,
                                                }
                                            })

                                        }
                                        await pdfPopup.close();
                                    }
                                    await popup.close();
                                } else {
                                    await Patient.updateOne({ _id: patient._id }, {
                                        $set: {
                                            status: "Failed",
                                            message: `No 'View Results' option for ${collectionDate}`,
                                        }
                                    })

                                }
                            } catch (err) {
                                await Patient.updateOne({ _id: patient._id }, {
                                    $set: {
                                        status: "Failed",
                                        message: `Result download error for ${collectionDate}: ${err.message}`,
                                    }
                                })

                            }

                            // ---- DOWNLOAD ORDER PDF ---- //
                            try {
                                console.log(`🧾 Attempting order download for ${collectionDate}...`);

                                // Always re-query dynamically (avoid stale handles)

                                const actionMenuLocator = await row.$('a.pccActionMenu');
                                // Click the action menu (retry up to 3 times if it detaches)
                                for (let attempt = 1; attempt <= 3; attempt++) {
                                    try {
                                        await actionMenuLocator.click({ timeout: 5000 });
                                        break;
                                    } catch (err) {
                                        if (err.message.includes('detached')) {
                                            console.warn(`⚠️ Action menu detached (attempt ${attempt}) — retrying...`);
                                            await page.waitForTimeout(1000);
                                        } else {
                                            throw err;
                                        }
                                        if (attempt === 3) throw new Error('Action menu could not be clicked after 3 retries');
                                    }
                                }

                                // Re-query "View Order" fresh each time — never from row.$()
                                const viewOrderLocator = page.locator('li:has-text("View Order")').first();

                                const hasViewOrder = await viewOrderLocator.count();
                                if (!hasViewOrder) {
                                    console.log(`ℹ️ No "View Order" option for ${collectionDate}`);
                                    await Patient.updateOne(
                                        { _id: patient._id },
                                        { $set: { status: "success", message: `No 'View Order' option for ${collectionDate}` } }
                                    );
                                    return;
                                }

                                // Wait for popup event
                                const [popupOrder] = await Promise.all([
                                    page.waitForEvent('popup'),
                                    viewOrderLocator.click()
                                ]);

                                await popupOrder.waitForLoadState('domcontentloaded');

                                // Adjust layout for full capture
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

                                // Save order PDF
                                await popupOrder.pdf({
                                    path: orderPdfPath,
                                    format: 'A4',
                                    printBackground: true,
                                    scale: 1,
                                    preferCSSPageSize: true
                                });

                                await popupOrder.close();

                                if (fs.existsSync(orderPdfPath)) {
                                    console.log(`✅ Order PDF saved for ${collectionDate}`);

                                    await Patient.updateOne(
                                        { _id: patient._id },
                                        { $set: { status: "success", message: "Order PDF Saved", orderPdfPath } }
                                    );

                                    // Merge result + order PDFs
                                    await mergePdfs(resultPdfPath, orderPdfPath, mergedPdfPath);

                                    if (fs.existsSync(mergedPdfPath)) {
                                        await Patient.updateOne(
                                            { _id: patient._id },
                                            { $set: { mergedPdfs: mergedPdfPath } }
                                        );
                                        console.log(`✅ Merged PDF created for ${collectionDate}`);
                                    } else {
                                        await Patient.updateOne(
                                            { _id: patient._id },
                                            {
                                                $set: {
                                                    status: "Failed",
                                                    message: `Merged PDF not found after merge for ${collectionDate}`,
                                                },
                                            }
                                        );
                                    }

                                    // Cleanup temporary files
                                    try {
                                        fs.unlinkSync(resultPdfPath);
                                        fs.unlinkSync(orderPdfPath);
                                    } catch (e) {
                                        await Patient.updateOne(
                                            { _id: patient._id },
                                            {
                                                $set: {
                                                    status: "Failed",
                                                    message: `Could not unlink temp files: ${e.message}`,
                                                },
                                            }
                                        );
                                    }
                                } else {
                                    await Patient.updateOne(
                                        { _id: patient._id },
                                        {
                                            $set: {
                                                status: "Failed",
                                                message: `Order PDF not created for ${collectionDate}`,
                                            },
                                        }
                                    );
                                }

                            } catch (err) {
                                console.error("❌ Order download err:", err);
                                await Patient.updateOne(
                                    { _id: patient._id },
                                    {
                                        $set: {
                                            status: "Failed",
                                            message: `Order download error for ${collectionDate}: ${err.message}`,
                                        },
                                    }
                                );
                            }

                        };

                    } // end rows loop

                    if (matchedCount === 0) {
                        await Patient.updateOne({ _id: patient._id }, {
                            $set: {
                                status: "Failed",
                                message: `No matching DOS found for ${patient.ResidentID}`,
                            }
                        })

                    }

                } catch (err) {
                    console.log("err", err)
                    await Patient.updateOne({ _id: patient._id }, {
                        $set: {
                            status: "Failed",
                            message: `Error: ${err.message}`,
                        }
                    })

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
