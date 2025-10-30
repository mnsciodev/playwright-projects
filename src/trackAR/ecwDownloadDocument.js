const { chromium } = require('playwright');
const path = require('path');
const fs = require("fs");
(async () => {
    // Connect to your existing browser session (CDP)
    const browser = await chromium.connectOverCDP('http://localhost:9223');
    const context = browser.contexts()[0];
    const page = context.pages().length ? context.pages()[0] : await context.newPage();

    try {
        const claimNo = '50872';

        // 1️⃣ Search claim
        // await page.fill('#claimLookupIpt10', claimNo);
        // await page.click('#btnclaimlookup');

        // // 2️⃣ Wait for the first modal to open
        // await page.waitForSelector('.modal.fade.bluetheme.billing-width.in', { state: 'visible', timeout: 20000 });

        // // 3️⃣ Click the dropdown button
        // const dropBtn = await page.waitForSelector('[id^="printHCFADropDown"]', { state: 'visible' });
        // await dropBtn.click();

        // // 4️⃣ Click "View HCFA (02-12)" via evaluate (avoids click interception)
        // await page.waitForSelector('#billingClaimLink17', { state: 'visible', timeout: 10000 });
        // await page.evaluate(() => document.querySelector('#billingClaimLink17').click());

        // // 5️⃣ Wait for HCFA modal to appear
        // await page.waitForSelector('.modal.claimforms-mod.in', { state: 'visible', timeout: 20000 });

        // // Wait for iframe inside modal
        // const iframe = await page.waitForSelector('#claimFormViewerFrame', { state: 'attached', timeout: 20000 });
        // let iframeSrc = await iframe.getAttribute('src');

        // // If iframe src is relative, fix it
        // iframeSrc = new URL(iframeSrc, page.url()).href;
        // console.log('📄 Iframe URL:', iframeSrc);

        // // Wait for it to actually load content (some eCW builds delay token generation)
        // await page.waitForTimeout(2000);

        // // Try to fetch with the same authenticated context
        // const pdfResponse = await context.request.get(iframeSrc, {
        //     headers: {
        //         'Referer': page.url(),
        //         'Accept': 'application/pdf',
        //         'User-Agent': await page.evaluate(() => navigator.userAgent),
        //         'Sec-Fetch-Dest': 'iframe',
        //         'Sec-Fetch-Mode': 'navigate',
        //         'Sec-Fetch-Site': 'same-origin',
        //     }
        // });

        // const contentType = pdfResponse.headers()['content-type'];

        // if (!pdfResponse.ok() || !contentType.includes('pdf')) {
        //     console.error('❌ Not a PDF response. Status:', pdfResponse.status());
        //     const text = await pdfResponse.text();
        //     fs.writeFileSync('debug_response.html', text);
        //     console.error('🧩 Saved HTML debug to debug_response.html');
        //     return;
        // }

        // const pdfBuffer = await pdfResponse.body();
        // const savePath = path.join(__dirname, `HCFA_${claimNo}.pdf`);
        // fs.writeFileSync(savePath, pdfBuffer);

        // console.log(`✅ PDF saved at: ${savePath}`);

        // // === 🧹 CLOSE MODALS ===
        // console.log('🧹 Closing HCFA modal...');
        // await page.evaluate(() => {
        //     const hcfaClose = document.querySelector('.modal.claimforms-mod.in .close, .modal.claimforms-mod.in [data-dismiss="modal"]');
        //     hcfaClose?.click();
        // });
        // await page.waitForSelector('.modal.claimforms-mod.in', { state: 'detached', timeout: 10000 });

        // console.log('🧹 Closing claim modal...');

        // console.log('🧭 Opening Progress Note...');

        // // 1️⃣ Click the "Prog. Note" button (dynamic ID)
        // const progNoteBtn = await page.waitForSelector('[id^="claimProgressNoteBtn"]', { state: 'visible', timeout: 15000 });
        // await progNoteBtn.click();

        // 2️⃣ Wait for Progress Note iframe
        const progIframe = await page.waitForSelector('#ProgNoteViwerFrame', { state: 'visible', timeout: 20000 });
        const progFrame = await progIframe.contentFrame();

        console.log('🕒 Waiting for Progress Note content to load...');
        await progFrame.waitForSelector('body', { timeout: 15000 });

        // Get the iframe body HTML
        const frameBodyContent = await progFrame.evaluate(() => document.body.outerHTML);

        // Optional: copy iframe styles
        const styles = await progFrame.evaluate(() => {
            return Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
                .map(el => el.outerHTML)
                .join('\n');
        });

        // Combine styles + body
        const htmlContent = `
            <html>
            <head>
            <meta charset="utf-8">
            ${styles}
            </head>
            <body>
            ${frameBodyContent}
            </body>
            </html>
        `;

        // Open a temporary page in the same context to render only iframe content
        const tempPage = await page.context().newPage();
        await tempPage.setContent(htmlContent, { waitUntil: 'networkidle' });

        const progPath = path.join(__dirname, `ProgNote_${claimNo}.pdf`);
        await tempPage.pdf({
            path: progPath,
            format: 'A4',
            printBackground: true,
        });

        await tempPage.close();
        console.log(`✅ Progress Note PDF saved at: ${progPath}`);

        const closeBtn = await page.waitForSelector("button[ng-click='closeProgressNoteViwer()']", { state: 'visible' });
        await closeBtn.click();
        // await page.evaluate(() => {
        //     const claimClose = document.querySelector('.modal.fade.bluetheme.billing-width.in .close, .modal.fade.bluetheme.billing-width.in [data-dismiss="modal"]');
        //     claimClose?.click();
        // });
        // await page.waitForSelector('.modal.fade.bluetheme.billing-width.in', { state: 'detached', timeout: 10000 });

        console.log('✅ Both modals closed successfully.');
    } catch (err) {
        console.error('❌ Workflow failed:', err);
    } finally {
        // Keep browser open for debugging, or uncomment to close
        // await browser.close();
    }
})();
