const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const mongoose = require('mongoose');


const baseDir = path.join(__dirname, 'pdf_output');
if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

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

(async () => {
    const browser = await chromium.launch({ headless: false, channel: 'chrome' });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // 1️⃣ Go to login page
        await page.goto('https://www30.pointclickcare.com/home/login.jsp', { timeout: 60000 });

        // 2️⃣ Fill username
        await page.fill('[name="un"]', 'elev.cneagu');

        // 3️⃣ Click "Next" and wait for password input to appear
        await page.click('#id-next');
        await page.waitForSelector('[data-test="login-password-input"]', { state: 'visible', timeout: 20000 });

        // 4️⃣ Fill password
        await page.fill('[data-test="login-password-input"]', 'Elevate2!');

        // 5️⃣ Click "Sign In" and wait for search field instead of global load
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

        await page.waitForSelector('#searchField', { state: 'visible', timeout: 60000 });
        var facilityName = "ELEVATE CARE CHICAGO NORTH"
        const selected = await selectFacilityWithRetry(page, facilityName, 3, 3000);
        if (!selected) {
            console.error(`🚫 Skipping facility: ${facilityName}`);

        }
        var ResidentID = "GC19740"
        // 6️⃣ Enter search value
        await page.fill('#searchField', ResidentID);

        // Press Enter and wait for the search results to load
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { }), // catches if SPA navigation doesn't occur
            page.keyboard.press('Enter')
        ]);


        await page.click('a[href*="labResults.xhtml"]');

        await page.waitForSelector('#filterTrigger', { state: 'visible', timeout: 30000 });

        // 3️⃣ Expand "Display Filters" if not already expanded
        const filterImg = await page.$('#filterTrigger img.plussign_img');
        const src = await filterImg.getAttribute('src');

        if (src.includes('newplus.gif')) {
            // Only click if filters are collapsed
            await page.click('#filterTrigger');
            // Wait for the image to change to minus
            await page.waitForFunction(() => {
                const img = document.querySelector('#filterTrigger img.plussign_img');
                return img && img.src.includes('newminus.gif');
            }, { timeout: 10000 });
        }

        // 4️⃣ Clear the date fields
        await page.fill('#reported_date_dummy', '');
        await page.fill('#collection_date_dummy', '');

        // 5️⃣ Click the Search button
        await Promise.all([
            page.waitForLoadState('networkidle'), // wait until search results load
            page.click('#refreshButtonId')
        ]);


        console.log('✅ Logged in and entered search value successfully.');
        const rows = await page.$$('#resultsTable tbody tr');
        var cleanDate = "9/23/2025"

        for (const row of rows) {
            const ts = Date.now();
            const collectionDate = await row.$eval('td:nth-child(6) span', el => el.textContent.trim());
            if (collectionDate.includes("9/23/2025")) {

                const resultPdfPath = path.join(baseDir, `${facilityName}_${ResidentID}_Result_${cleanDate}_${ts}.pdf`);
                const orderPdfPath = path.join(baseDir, `${facilityName}_${ResidentID}_Order_${cleanDate}_${ts}.pdf`);
                const mergedPdfPath = path.join(baseDir, `${facilityName}_${ResidentID}_Merged_${cleanDate}_${ts}.pdf`);
                const actionsMenu = await row.$('a.pccActionMenu');
                await actionsMenu.click();
                const viewResults = await row.$('li:has-text("View Results")');
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


                    }
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


                    await popupOrder.close();
                }
            }
        }
    } catch (err) {
        console.error('❌ Script failed:', err.message);
    } finally {
        // keep browser open for debugging
        // await browser.close();
    }
})();
