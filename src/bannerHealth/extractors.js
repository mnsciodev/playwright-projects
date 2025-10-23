async function getFieldValueByLabel(page, containerSelector, labelText) {
    const container = page.locator(containerSelector);
    await container.waitFor({ state: 'attached', timeout: 3000 }).catch(() => { });
    const rowSelector = `tr:has(label:has-text("${labelText}"))`;
    const row = container.locator(rowSelector);

    if (await row.count() > 0) {
        const tds = row.locator('td');
        const tdCount = await tds.count();
        for (let i = 0; i < tdCount; i++) {
            const hasLabel = (await tds.nth(i).locator('label').count()) > 0;
            if (!hasLabel) {
                const txt = (await tds.nth(i).innerText()).trim();
                if (txt) return txt.replace(/\s+/g, ' ');
            }
        }
    }

    return '';
}

module.exports = { getFieldValueByLabel };
