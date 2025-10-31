const { chromium } = require('playwright');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

(async () => {
  try {
    const chromePath = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"`;
    const userDataDir = `"C:\\temp\\chrome-profile"`;

    // 1️⃣ Launch Chrome with remote debugging enabled
    console.log('🚀 Launching Chrome...');
    exec(`${chromePath} --remote-debugging-port=9223 --user-data-dir=${userDataDir}`, (error) => {
      if (error) console.error('Chrome launch error:', error);
    });

    // 2️⃣ Wait for Chrome to start
    console.log('⏳ Waiting for Chrome to initialize...');
    await new Promise(resolve => setTimeout(resolve, 4000));

    // 3️⃣ Connect to that Chrome instance
    console.log('🔗 Connecting Playwright to Chrome...');
    const browser = await chromium.connectOverCDP('http://localhost:9223');
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());

    // 4️⃣ Go to ECW claim page
    console.log('🌐 Navigating to ECW...');
    await page.goto('https://YOUR-ECW-URL-HERE'); // 🔁 Replace with your actual ECW URL

    // 5️⃣ Perform your workflow
    await page.fill('#claimLookupIpt10', '50872');
    await page.click('#btnclaimlookup');

    await page.waitForSelector('.modal.fade.bluetheme.billing-width.in', { timeout: 20000 });

    const dropBtn = await page.$('[id^="printHCFADropDown"]');
    await dropBtn.click();

    await page.click('#billingClaimLink11');

    const iframeElement = await page.waitForSelector('#claimFormViewerFrame', { timeout: 15000 });
    const iframeSrc = await iframeElement.getAttribute('src');
    const iframeUrl = new URL(iframeSrc, page.url()).href;

    console.log('📄 PDF iframe URL:', iframeUrl);

    // 6️⃣ Download the PDF
    const pdfResponse = await context.request.get(iframeUrl);
    const pdfBuffer = await pdfResponse.body();

    const savePath = path.join(__dirname, 'HCFA_50872.pdf');
    fs.writeFileSync(savePath, pdfBuffer);
    console.log(`✅ PDF saved at: ${savePath}`);

  } catch (err) {
    console.error('❌ Workflow failed:', err);
  }
})();
