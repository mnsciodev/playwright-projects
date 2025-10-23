const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib'); // npm install pdf-lib

(async () => {
    const browser = await chromium.launch({ headless: false, channel: 'chrome' });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // --- LOGIN AND SEARCH RESIDENT ---
        await page.goto('https://www30.pointclickcare.com/home/login.jsp', { timeout: 60000 });
        await page.fill('[name="un"]', 'aper.marcusw');
        await page.click('#id-next');
        await page.waitForSelector('[data-test="login-password-input"]', { state: 'visible', timeout: 20000 });
        await page.fill('[data-test="login-password-input"]', 'Simple@#$2027');
        await page.click('[data-test="login-signIn-button"]');
        await page.waitForSelector('#searchField', { state: 'visible', timeout: 60000 });
        await page.fill('#searchField', '1162');
        await Promise.all([
            page.keyboard.press('Enter'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { })
        ]);

        // --- CLICK RESULTS TAB ---
        await page.click('a[href*="labResults.xhtml"]');
        await page.waitForSelector('#filterTrigger', { state: 'visible', timeout: 30000 });

        // --- EXPAND DISPLAY FILTERS ---
        const filterImg = await page.$('#filterTrigger img.plussign_img');
        const src = await filterImg.getAttribute('src');
        if (src.includes('newplus.gif')) {
            await page.click('#filterTrigger');
            await page.waitForFunction(() => {
                const img = document.querySelector('#filterTrigger img.plussign_img');
                return img && img.src.includes('newminus.gif');
            }, { timeout: 10000 });
        }

        // --- CLEAR DATE FILTERS AND SEARCH ---
        await page.fill('#reported_date_dummy', '');
        await page.fill('#collection_date_dummy', '');
        await Promise.all([
            page.click('#refreshButtonId'),
            page.waitForSelector('#resultsTable', { state: 'visible', timeout: 60000 })
        ]);

        const rows = await page.$$('#resultsTable tbody tr');
        const targetDate = '5/21/2025'; // desired date
        let mergedPdfDoc = await PDFDocument.create();

        for (const row of rows) {
            const collectionDate = await row.$eval('td:nth-child(6) span', el => el.textContent.trim());
            if (!collectionDate.includes(targetDate)) continue;

            console.log(`✅ Matched row with collection date: ${collectionDate}`);
            const actionsMenu = await row.$('a.pccActionMenu');
            await actionsMenu.click();

            // --- CHECK FOR VIEW RESULTS OR VIEW ORDER ---
            const viewResults = await row.$('li:has-text("View Results")');
            const viewOrder = await row.$('li:has-text("View Order")');

            if (viewResults) {
                // --- VIEW RESULTS ---
                const [popup] = await Promise.all([
                    page.waitForEvent('popup'),
                    viewResults.click()
                ]);
                await popup.waitForLoadState('domcontentloaded');

                const viewFileBtn = await popup.waitForSelector('#viewFileButton', { state: 'visible', timeout: 10000 });
                if (viewFileBtn) {
                    const onclickAttr = await viewFileBtn.getAttribute('onclick');
                    if (onclickAttr) {
                        const match = onclickAttr.match(/openPDFReport\('(\d+)','(\d+)'\)/);
                        if (match) {
                            const fileId = match[2];
                            const finalPdfUrl = `https://www30.pointclickcare.com/clinical/lab/popup/viewReport.xhtml?fileId=${fileId}`;
                            const pdfResponse = await page.request.get(finalPdfUrl);
                            const buffer = await pdfResponse.body();

                            const pdfDoc = await PDFDocument.load(buffer);
                            const copiedPages = await mergedPdfDoc.copyPages(pdfDoc, pdfDoc.getPageIndices());
                            copiedPages.forEach(p => mergedPdfDoc.addPage(p));

                            console.log(`✅ Added VIEW RESULTS PDF for ${collectionDate}`);
                        }
                    }
                }
                await popup.close();
            }

            if (viewOrder) {
                // --- VIEW ORDER ---
                const [popup] = await Promise.all([
                    page.waitForEvent('popup'),
                    viewOrder.click()
                ]);
                await popup.waitForLoadState('domcontentloaded');

                // Expand Scheduling Details
                const schedDiv = await popup.waitForSelector('#scheduleDetailsBar', { state: 'visible', timeout: 10000 });
                const img = await schedDiv.$('img');
                const imgSrc = await img.getAttribute('src');
                if (imgSrc.includes('newplus.gif')) {
                    await schedDiv.click();
                    await popup.waitForFunction(() => {
                        const img = document.querySelector('#scheduleDetailsBar img');
                        return img && img.src.includes('newminus.gif');
                    }, { timeout: 10000 });
                }

                // Check for PDF inside popup
                const viewFileBtn = await popup.$('#viewFileButton');
                if (viewFileBtn) {
                    const onclickAttr = await viewFileBtn.getAttribute('onclick');
                    if (onclickAttr) {
                        const match = onclickAttr.match(/openPDFReport\('(\d+)','(\d+)'\)/);
                        if (match) {
                            const fileId = match[2];
                            const finalPdfUrl = `https://www30.pointclickcare.com/clinical/lab/popup/viewReport.xhtml?fileId=${fileId}`;
                            const pdfResponse = await page.request.get(finalPdfUrl);
                            const buffer = await pdfResponse.body();

                            const pdfDoc = await PDFDocument.load(buffer);
                            const copiedPages = await mergedPdfDoc.copyPages(pdfDoc, pdfDoc.getPageIndices());
                            copiedPages.forEach(p => mergedPdfDoc.addPage(p));

                            console.log(`✅ Added VIEW ORDER PDF for ${collectionDate}`);
                        }
                    }
                }

                await popup.close();
            }
        }

        // --- SAVE MERGED PDF ---
        const mergedPdfBytes = await mergedPdfDoc.save();
        const mergedFilePath = path.join(__dirname, `Resident_1162_${targetDate}_merged.pdf`);
        fs.writeFileSync(mergedFilePath, mergedPdfBytes);
        console.log(`✅ All PDFs merged and saved: ${mergedFilePath}`);

    } catch (err) {
        console.error('❌ Script failed:', err.message);
    } finally {
        // await browser.close();
    }
})();
