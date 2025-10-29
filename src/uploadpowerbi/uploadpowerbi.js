require("dotenv").config();
const { chromium } = require("playwright");
const conn = require("../Config/database");
 
function queryAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        conn.query(sql, params, (err, results) => {
            if (err) return reject(err);
            resolve(results);
        });
    });
}
 
function convertMonth(dbMonth) {
    const [mon, yy] = dbMonth.split("-");
    const months = {
        Jan: "January", Feb: "February", Mar: "March", Apr: "April",
        May: "May", Jun: "June", Jul: "July", Aug: "August",
        Sep: "September", Oct: "October", Nov: "November", Dec: "December"
    };
    return `${months[mon]} 20${yy}`;
}
 
 
// ------------------- FIXED clickWithRetry -------------------
async function clickWithRetry(page, containerLocator, optionText, inputSelector = null, maxRetries = 5, delay = 500) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            // Open dropdown
            await containerLocator.click();
            await page.waitForTimeout(300);
 
            // If it's a searchable dropdown, type text
            if (inputSelector) {
                await page.fill(inputSelector, optionText);
                await page.waitForTimeout(500);
            }
 
            // Log all available options for debugging
            const options = await page.locator('div[id^="react-select"]').allTextContents();
            console.log("Available options:", options);
 
            // Find exact match
            const exactMatchLocator = page.locator('div[id^="react-select"]', {
                hasText: new RegExp(`^${optionText}$`)
            });
 
            const count = await exactMatchLocator.count();
            if (count === 0) {
                throw new Error(`Exact match not found for "${optionText}". Options were: ${options.join(", ")}`);
            }
 
            await exactMatchLocator.first().click();
            console.log(`✅ Selected: "${optionText}"`);
            return true;
 
        } catch (err) {
            console.log(`⚠️ Attempt ${i + 1} failed for "${optionText}" → ${err.message}`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
 
    throw new Error(`❌ Failed to select dropdown option after ${maxRetries} retries: ${optionText}`);
}
 
// ---------------- Validation ----------------
async function validatePractice(practiceName, reportName, month) {
    const pmRows = await queryAsync(
        `SELECT pm_system_name FROM practice_master WHERE practice_name = ? LIMIT 1`,
        [practiceName]
    );
    if (pmRows.length === 0) {
        console.log(` Practice not found: ${practiceName}`);
        return false;
    }
 
    const mandatoryRows = await queryAsync(
        `SELECT table_name FROM powerbi_report_master WHERE report_name = ? AND mandatory = 'Yes'`,
        [reportName]
    );
    const mandatoryTables = mandatoryRows.map(r => r.table_name);
    if (mandatoryTables.length === 0) {
        console.log(` No mandatory tables for report: ${reportName}`);
        return false;
    }
 
    const uploadedRows = await queryAsync(
        `SELECT table_name FROM powerbi_upload_history WHERE practice_name = ? AND month = ? AND active_status = 1`,
        [practiceName, month]
    );
    const uploadedTables = uploadedRows.map(r => r.table_name);
 
    const missing = mandatoryTables.filter(t => !uploadedTables.includes(t));
    if (missing.length > 0) {
        console.log(` ${practiceName} missing: ${missing.join(", ")}`);
        return false;
    }
 
    console.log(` ${practiceName} is valid for ${reportName} (${month})`);
    return true;
}
 
// ---------------- Popup Handling ----------------
async function waitAndCloseOkPopup(page, maxWaitMs = 300000) {
    const start = Date.now();
 
    while (Date.now() - start < maxWaitMs) {
        try {
            const okButton = page.locator('button:has-text("OK")');
            const closeButton = page.locator('button:has-text("Close")');
            const updatedPopup = page.locator('div:has-text("Power BI data updated")');
 
            await page.waitForTimeout(2000);
 
            if (await okButton.isVisible()) {
                console.log(" 'OK' button detected. Clicking...");
                await okButton.click();
                return;
            }
 
            if (await closeButton.isVisible()) {
                console.log(" 'Close' button detected. Clicking...");
                await closeButton.click();
                return;
            }
 
            if (await updatedPopup.isVisible()) {
                console.log(" 'Power BI data updated' popup detected.");
                const popupOk = updatedPopup.locator('button:has-text("OK")');
                if (await popupOk.isVisible()) {
                    console.log(" Clicking popup OK...");
                    await popupOk.click();
                    return;
                }
            }
 
        } catch (err) {
            console.log(" Error while checking popup:", err.message);
        }
 
        console.log(" Waiting for popup to appear...");
    }
 
    console.log(" Timed out waiting for confirmation popup.");
}
 
// ---------------- Tracker Functions ----------------
async function markAsProcessed(practiceName, month, reportName) {
    await queryAsync(
        `INSERT INTO powerbi_upload_tracker (practice_name, month, report_name, processed)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE processed = 1, processed_at = NOW()`,
        [practiceName, month, reportName]
    );
    console.log(` ✅ Marked as processed → ${practiceName} | ${month} | ${reportName}`);
}
 
async function isAlreadyProcessed(practiceName, month, reportName) {
    const rows = await queryAsync(
        `SELECT processed FROM powerbi_upload_tracker
         WHERE practice_name = ? AND month = ? AND report_name = ? AND processed = 1`,
        [practiceName, month, reportName]
    );
    return rows.length > 0;
}
 
// ---------------- Main Automation ----------------
async function runAutomation() {
    try {
        const historyRows = await queryAsync(
            `SELECT
                puh.practice_name,
                puh.month,
                prm.report_name,
                prm.title AS title_name,
                pm.pm_system_name
             FROM practice_master pm
             JOIN powerbi_upload_history puh ON puh.practice_name = pm.practice_name
             JOIN powerbi_report_master prm ON prm.table_name = puh.table_name
             WHERE puh.active_status = 1 AND prm.mandatory = 'Yes'
             GROUP BY puh.practice_name, puh.month, prm.report_name, prm.title, pm.pm_system_name
             HAVING COUNT(DISTINCT prm.table_name) = (
                 SELECT COUNT(DISTINCT table_name)
                 FROM powerbi_report_master
                 WHERE report_name = prm.report_name AND mandatory = 'Yes'
             )
             ORDER BY puh.practice_name, puh.month`
        );
 
        if (historyRows.length === 0) {
            console.log(" No valid practice/report/month combinations found");
            return;
        }
 
        const browser = await chromium.launch({ headless: false,channel: "chrome",slowMo: 100 });
        const page = await browser.newPage();
 
        await page.goto("https://sciomskpi.com/auth", { waitUntil: "domcontentloaded" });
        await page.getByPlaceholder("Email").fill("rathi@scioms.com");
        await page.locator('input[type="password"]').fill("Rathi@008");
        await page.getByRole("button", { name: /Login/i }).click();
        await page.waitForNavigation({ waitUntil: "networkidle" });
 
        const userManagement = page.locator('//span[@class="menu-title" and normalize-space()="Report Management"]');
        await userManagement.click();
        await page.waitForSelector('a[href="/UploadPowerBIReports"]', { state: "visible" });
        await page.click('a[href="/UploadPowerBIReports"]');
 
        const grouped = {};
        for (const row of historyRows) {
            const key = `${row.practice_name}||${row.month}||${row.pm_system_name}`;
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(row);
        }
 
        for (const key of Object.keys(grouped)) {
            const [practiceName, monthDb, pmSystem] = key.split("||");
            const formattedMonth = convertMonth(monthDb);
 
            console.log(`\n Processing Practice=${practiceName}, Month=${monthDb}`);
 
            await clickWithRetry(page, page.locator('#PmId'), pmSystem,'#react-select-3-input');
            await clickWithRetry(page, page.locator('#Practice'), practiceName, '#react-select-4-input');
            const monthInput = page.locator('input[placeholder="mmmm yyyy"]');
            await monthInput.fill(formattedMonth);
 
            for (const row of grouped[key]) {
                const reportName = row.title_name;
 
                if (await isAlreadyProcessed(practiceName, monthDb, row.report_name)) {
                    console.log(` ⏭ Skipping already processed: ${practiceName} | ${monthDb} | ${reportName}`);
                    continue;
                }
 
                try {
                    await clickWithRetry(page, page.locator('#ReportName'), reportName, '#react-select-5-input');
 
                    const isValid = await validatePractice(practiceName, row.report_name, monthDb);
                    if (!isValid) {
                        console.log(`⏭ Skipping update for ${practiceName} report ${reportName}`);
                        continue;
                    }
 
                    console.log(`[${new Date().toISOString()}] ▶️ Updating report: ${reportName}`);
                    await page.waitForTimeout(1500);
 
                    await page.click('button.btn.btn-primary');
                    console.log(" Clicked Update button");
 
                    await waitAndCloseOkPopup(page);
 
                    await markAsProcessed(practiceName, monthDb, row.report_name);
 
                } catch (err) {
                    console.error(` Error updating report ${reportName} for ${practiceName}:`, err.message);
                }
            }
 
            try {
                const monthEndReportName = "Month End Data";
                console.log(`\n🔄 Uploading Month End Data for ${practiceName}`);
 
                await clickWithRetry(page, page.locator('#ReportName'), monthEndReportName, '#react-select-5-input');
                await page.waitForTimeout(1500);
 
                await page.click('button.btn.btn-primary');
                console.log(" Clicked Update for Month End Data");
 
                await waitAndCloseOkPopup(page);
 
            } catch (err) {
                console.error(` Error updating Month End Data for ${practiceName}:`, err.message);
            }
        }
 
        await browser.close();
        console.log(" Finished all practices");
 
    } catch (err) {
        console.error(" Error in automation:", err);
    }
}
 
// ------------------ Run ------------------
if (require.main === module) {
    runAutomation()
        .then(() => console.log(" Automation finished"))
        .catch(err => console.error(" Failed:", err));
}
 
module.exports = { runAutomation };