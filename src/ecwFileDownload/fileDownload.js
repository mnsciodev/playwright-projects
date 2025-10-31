const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
    // 1️⃣ Connect to your existing Chrome instance (started with --remote-debugging-port=9222)
    const browser = await chromium.connectOverCDP('http://localhost:9223');
    const context = browser.contexts()[0];
    const page = context.pages().length ? context.pages()[0] : await context.newPage();

    try {
        // 2️⃣ Open the claim
        await page.fill('#claimLookupIpt10', '50872');
        await page.click('#btnclaimlookup');

        // Wait for the claim modal to open
        await page.waitForSelector('.modal.fade.bluetheme.billing-width.in', { state: 'visible', timeout: 20000 });

        // 3️⃣ Click “View HCFA (02-12)”
        await page.waitForSelector('[id^="printHCFADropDown"]', { state: 'visible' });
        await page.click('[id^="printHCFADropDown"]');

        // This triggers the HCFA viewer modal
        await page.evaluate(() => document.querySelector('#billingClaimLink17').click());

        // 4️⃣ Wait for the HCFA modal and iframe
        const modal = await page.waitForSelector('.modal.claimforms-mod.in', { state: 'visible', timeout: 20000 });
        const iframeHandle = await modal.$('#claimFormViewerFrame');


        // Build the full iframe URL
        let iframeSrc = await iframeHandle.getAttribute('src');
        const baseUrl = new URL(page.url()).origin;
        if (!iframeSrc.startsWith('http')) iframeSrc = baseUrl + iframeSrc;

        console.log(`🌐 Fetching HCFA PDF from: ${iframeSrc}`);

        // ✅ Use page.request (keeps same cookies/session)
        const pdfResponse = await page.request.get(iframeSrc, {
            headers: {
                'Referer': page.url(),
                'User-Agent': await page.evaluate(() => navigator.userAgent),
            }
        });

        // Check if successful
        if (!pdfResponse.ok()) {
            throw new Error(`Failed to download PDF: ${pdfResponse.status()} ${pdfResponse.statusText()}`);
        }

        // Save the PDF
        const pdfBuffer = await pdfResponse.body();
        const savePath = path.join(__dirname, 'HCFA_50872.pdf');
        fs.writeFileSync(savePath, pdfBuffer);
        console.log(`✅ HCFA PDF saved at: ${savePath}`);


        await page.click('[id^="claimProgressNoteBtn"]');
        const frameHandle = await page.waitForSelector('#ProgNoteViwerFrame', { timeout: 20000 });
        const frame = await frameHandle.contentFrame();
        if (!frame) throw new Error('❌ Unable to access iframe');

        // Wait for iframe content to be non-empty
        await frame.waitForFunction(() => {
            const html = document.body.innerHTML.trim();
            return html.length > 10; // adjust length if needed
        }, { timeout: 20000 });

        // Get the fully rendered HTML
        const iframeHTML = await frame.evaluate(() => document.documentElement.outerHTML);

        // Open a temporary page to render PDF
        const tempPage = await context.newPage();
        await tempPage.setContent(iframeHTML, { waitUntil: 'networkidle' });

        // Save as PDF
        const pdfPath = path.join(__dirname, 'ProgressNote.pdf');
        await tempPage.pdf({ path: pdfPath, format: 'A4', printBackground: true });
        console.log(`✅ Progress Note saved as PDF at: ${pdfPath}`);

        await tempPage.close();
    } catch (err) {
        console.error('❌ Workflow failed:', err);
    } finally {
        // ⚠️ Don’t close the browser if you want to keep the ECW session active
        // await browser.close();
    }
})();
