async function retrySelector(page, selector, timeout = 30000, retries = 3) {
    let attempts = 0;
    while (attempts < retries) {
        try {
            await page.locator(selector).waitFor({ state: 'visible', timeout });
            return true;
        } catch {
            attempts++;
            if (attempts >= retries) {
                throw new Error(`❌ Failed to find ${selector} after ${retries} attempts`);
            }
            console.log(`Retrying ${selector}... (${attempts}/${retries})`);
        }
    }
}

module.exports = { retrySelector };
