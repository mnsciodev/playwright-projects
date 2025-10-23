const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: false, channel: 'chrome' });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // 1️⃣ Go to login page
        await page.goto('https://www30.pointclickcare.com/home/login.jsp', { timeout: 60000 });

        // 2️⃣ Fill username
        await page.fill('[name="un"]', 'aper.marcusw');

        // 3️⃣ Click "Next" and wait for password input to appear
        await page.click('#id-next');
        await page.waitForSelector('[data-test="login-password-input"]', { state: 'visible', timeout: 20000 });

        // 4️⃣ Fill password
        await page.fill('[data-test="login-password-input"]', 'Simple@#$2027');

        // 5️⃣ Click "Sign In" and wait for search field instead of global load
        await page.click('[data-test="login-signIn-button"]');
        await page.waitForSelector('#searchField', { state: 'visible', timeout: 60000 });

        // 6️⃣ Enter search value
        await page.fill('#searchField', '1162');

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

    } catch (err) {
        console.error('❌ Script failed:', err.message);
    } finally {
        // keep browser open for debugging
        // await browser.close();
    }
})();
