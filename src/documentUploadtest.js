const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const moment = require("moment")
const { mouse } = require("@computer-use/nut-js");
mouse.config.mouseSpeed = 800;


(async () => {
    try {

        const browser = await chromium.connectOverCDP('http://localhost:9222');
        const context = browser.contexts()[0];
        const page = context.pages().length ? context.pages()[0] : await context.newPage();


        await page.fill('#searchText', "john");
        

        await page.click('#patientSearchBtn1');

        await page.waitForTimeout(5000);  // wait 5 seconds to let the table load

        await page.waitForSelector('#pt-lookup-modal-dialog', { state: 'attached' });
        await page.waitForSelector('#pt-lookup-modal-dialog #rule-table2', { state: 'attached' });

        const tableLocator = page.locator('#pt-lookup-modal-dialog #rule-table2').first();

        const rowCount = await tableLocator.locator('tr').count();
        console.log(`Row count: ${rowCount}`);
        // const tableLocator = page.locator('#pt-lookup-modal-dialog #rule-table2').first();

        // await page.waitForSelector('#pt-lookup-modal-dialog', { state: 'attached' });
        // await page.waitForSelector('#pt-lookup-modal-dialog #rule-table2', { state: 'attached' });

        // const isVisible = await tableLocator.isVisible();
        // console.log('Is table visible?', isVisible);

        // if (isVisible) {
        //     const rowCount = await tableLocator.locator('tr').count();
        //     console.log(`Row count inside #rule-table2: ${rowCount}`);
        // } else {
        //     await page.click('#patientSearchBtn1');
        //     console.log('Table is hidden');
        // }


    } catch (err) {
        console.error('Error in workflow:', err);

    } finally {

    }
})();