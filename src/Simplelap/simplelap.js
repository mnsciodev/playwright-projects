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

// ---------------------- MAIN SCRIPT ---------------------- //
(async () => {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB");

    const GroupByClients = await Patient.aggregate([
        { $match: { status: { $ne: "success" } } },
        {
            $group: {
                _id: "$Client",      // Group by Client
                count: { $sum: 1 }   // Count number of documents per client
            }
        },
        {
            $sort: {
                count: -1           // Sort by count descending (or use _id:1 to sort by client name)
            }
        }
    ]);

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
            const facilityName = GetLocation._id;
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

            async function retryClick(selector, maxRetries = 5, delay = 1000) {
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

            // Usage
            await retryClick('#pccFacLink');


            // Normalize name for flexible regex
            const normalizedName = facilityName
                .replace(/\b(of|the|care)\b/gi, '') // remove filler words
                .replace(/\s+/g, '.*')              // allow flexible spaces
                .trim();

            // // Wait until the facility list <ul> appears inside that container
            // await page.waitForSelector('#optionList', { state: 'attached', timeout: 60000 });

            // // Wait for at least one facility <li> to be visible (the actual options)
            // await page.waitForSelector('#optionList li', { state: 'visible', timeout: 60000 });

            await page.waitForTimeout(10000);

            await page.click('#pccFacLink', { force: true });


            const regex = new RegExp(normalizedName, 'i');
            const facilityLocator = page.locator('ul#optionList a', { hasText: regex });

            try {
                await facilityLocator.waitFor({ state: 'visible', timeout: 10000 });
                await facilityLocator.click();
                console.log(`✅ Selected facility: ${facilityName}`);
            } catch (error) {
                console.warn(`⚠️ Could not find exact match for "${facilityName}". Trying fallback...`);

                const allFacilities = await page.locator('ul#optionList a').allTextContents();
                console.log("allFacilities", allFacilities)
                const fallback = allFacilities.find(opt =>
                    opt.toLowerCase().includes(
                        facilityName.toLowerCase().replace(/\b(of|the|care)\b/g, '').trim()
                    )
                );

                if (fallback) {
                    console.log(`🔄 Fallback matched: ${fallback}`);
                    await page.locator(`ul#optionList a:has-text("${fallback}")`).click();
                } else {
                    console.error(`❌ No facility found for ${facilityName}`);
                    continue; // move to next location
                }
            }
            console.log(`🎯 ${facilityName} loaded successfully.`);

            await page.waitForSelector('#searchField', { state: 'visible', timeout: 60000 });

            //await page.waitForLoadState('networkidle');

            const patients = await Patient.find({ status: { $ne: "completed" }, Client: facilityName });
            await page.waitForTimeout(3000);

            for (const patient of patients) {
                try {
                    console.info("patient", patient.ResidentID, patient.dos)
                    await page.fill('#searchField', patient.ResidentID);
                    await page.keyboard.press('Enter');
                    await page.waitForTimeout(3000);

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


                    let matchedCount = 0;

                    for (const row of rows) {
                        const collectionDate = await row.$eval('td:nth-child(6) span', el => el.textContent.trim());
                        console.log("collectionDate", collectionDate)
                        if (!collectionDate.includes(patient.dos)) continue;

                        matchedCount++;
                        const cleanDate = collectionDate.replace(/[/: ]/g, '_');
                        const ts = Date.now();
                        const resultPdfPath = path.join(baseDir, `${patient.ResidentID}_Result_${cleanDate}_${ts}.pdf`);
                        const orderPdfPath = path.join(baseDir, `${patient.ResidentID}_Order_${cleanDate}_${ts}.pdf`);
                        const mergedPdfPath = path.join(baseDir, `${patient.ResidentID}_Merged_${cleanDate}_${ts}.pdf`);

                        // Ensure patient.files exists (safety)
                        if (!Array.isArray(patient.files)) patient.files = [];

                        // ---- DOWNLOAD RESULT PDF ---- //
                        try {
                            const actionsMenu = await row.$('a.pccActionMenu');
                            await actionsMenu.click();
                            const viewResults = row.locator('li', { hasText: 'View Results' });
                            if (await viewResults.count()) {
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
                            const actionsMenuOrder = await row.$('a.pccActionMenu');
                            await actionsMenuOrder.click();
                            const viewOrder = await row.$('li:has-text("View Order")');

                            const viewResults = row.locator('li', { hasText: 'View Order' });
                            if (await viewResults.count()) {
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


                                    await Patient.updateOne({ _id: patient._id }, {
                                        $set: {
                                            status: "success",
                                            message: "Order PDF Saved",
                                            orderPdfPath: orderPdfPath
                                        }
                                    })

                                    await mergePdfs(resultPdfPath, orderPdfPath, mergedPdfPath);
                                    if (fs.existsSync(mergedPdfPath)) {


                                        await Patient.updateOne({ _id: patient._id }, {
                                            $set: {
                                                mergedPdfs: mergedPdfPath,
                                            }
                                        })
                                    } else {
                                        await Patient.updateOne({ _id: patient._id }, {
                                            $set: {
                                                status: "Failed",
                                                message: `Merged PDF not found after merge for ${collectionDate}`,
                                            }
                                        })

                                    }


                                    // remove temp result/order files if merged saved
                                    try {
                                        fs.unlinkSync(resultPdfPath)
                                        fs.unlinkSync(orderPdfPath)
                                    } catch (e) {
                                        await Patient.updateOne({ _id: patient._id }, {
                                            $set: {
                                                status: "Failed",
                                                message: `Could not unlink temp files: ${e.message}`,
                                            }
                                        })
                                    }
                                } else {
                                    await Patient.updateOne({ _id: patient._id }, {
                                        $set: {
                                            status: "Failed",
                                            message: `Order PDF not created for ${collectionDate}`,
                                        }
                                    })

                                }

                                await popupOrder.close();
                            } else {
                                await Patient.updateOne({ _id: patient._id }, {
                                    $set: {
                                        status: "success",
                                        message: `No 'View Order' option for ${collectionDate}`,
                                    }
                                })

                            }
                        } catch (err) {
                            await Patient.updateOne({ _id: patient._id }, {
                                $set: {
                                    status: "Failed",
                                    message: `Order download error for ${collectionDate}: ${err.message}`,
                                }
                            })

                        }
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
