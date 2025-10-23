const { chromium } = require('playwright');
const { mouse, keyboard, Key } = require("@computer-use/nut-js");
mouse.config.mouseSpeed = 800;

(async () => {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const context = browser.contexts()[0];
    const page = context.pages().length ? context.pages()[0] : await context.newPage();

    console.log('Connected to Chrome tab with URL:', page.url());

    await page.locator('#jellybean-panelLink65').click();
    await page.waitForSelector('#searchText', { state: 'visible' });

    await page.fill('#searchText', 'KIGHT, DWAYNE');

    await page.type('#patientSearchIpt3', '06221960');

    await page.waitForSelector('#pt-lookup-modal-dialog', { state: 'visible' });
    const patientLastName = page.locator('#patientLName1');
    await patientLastName.click();

    await page.waitForSelector('#patient_hub', { state: 'visible' });
    const patientDocsButton = page.locator('#patient-hubBtn11');

    await patientDocsButton.click();

    await page.waitForSelector('#modalPatientDocs', { state: 'visible' });

    const hospitalRecordsFolder = page.locator(
        '#modalPatientDocs a.active',
        { hasText: 'Hospital Records' }
    ).first();

    await hospitalRecordsFolder.click();

    const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.locator('#modalPatientDocs #patientdocsBtn4').click(),
    ]);

    await fileChooser.setFiles('C:\\Users\\madan\\Downloads\\KIGHT, DWAYNE- MMH-Kessler-08142025.pdf');

    const modal = page.locator('#documentReferal');
    await modal.waitFor({ state: 'visible' });

    const closeButton = modal.locator('.modal-header >> #savePrompt-tplBtn1').first();
    await closeButton.click();

    try {
        await modal.waitFor({ state: 'hidden', timeout: 3000 });
        console.log('Modal closed successfully');
    } catch (err) {
        console.log('Modal is still visible', err);
    }


    const modalmodalPatientDocs = page.locator('#modalPatientDocs');
    await modalmodalPatientDocs.waitFor({ state: 'visible' });

    const closeButtonPatientDocs = modalmodalPatientDocs.locator('.modal-header >> #savePrompt-tplBtn1').first();
    await closeButtonPatientDocs.click();

    try {
        await modalmodalPatientDocs.waitFor({ state: 'hidden', timeout: 3000 });
        console.log('Patient Docs Modal closed successfully');
    } catch (err) {
        console.log('Patient Docs  Modal is still visible', err);
    }

    const modalpatient_hub = page.locator('#patient_hub');
    await modalpatient_hub.waitFor({ state: 'visible' });

    const closepatient_hub = modalpatient_hub.locator('.modal-header >> #patient-hubBtn1').first();
    await closepatient_hub.click();

    try {
        await modalpatient_hub.waitFor({ state: 'hidden', timeout: 3000 });
        console.log('patient_hub Modal closed successfully');
    } catch (err) {
        console.log('patient_hub  Modal is still visible', err);
    }
})();