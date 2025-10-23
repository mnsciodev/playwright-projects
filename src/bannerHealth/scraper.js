const { chromium } = require("playwright");
const { retrySelector } = require("./retry");
const { getFieldValueByLabel } = require("./extractors");
const { connectDB, getDataFromMongo, updateProgress } = require("../Config/db");

async function runScraper() {
    const db = await connectDB();
    const records = await getDataFromMongo(db);

    if (!records.length) {
        console.log("No records found in MongoDB.");
        return;
    }

    const browser = await chromium.launch({ headless: false, channel: "chrome" });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // 🔑 Login
        console.log("🔑 Logging in...");
        await page.goto("https://eservices.uph.org/Account/Login?ReturnUrl=%2F", { timeout: 60000 });
        await page.fill("#Email", "hmatthews@scioms.com");
        await page.fill("#Password", "Welcome@12345");
        await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded" }),
            page.click('input[value="Log in"]')
        ]);
        console.log("✅ Logged in successfully.");

        // 🚀 Loop through each record
        for (const [index, row] of records.entries()) {
            const memberId = row.InsuranceNum;
            const patientDob = row.PatientDOB;
            const payerName = row.PayerName;
            console.log(`🔍 [${index + 1}/${records.length}] Processing MemberID=${memberId}, DOB=${patientDob}`);

            try {
                // Search member
                await retrySelector(page, "#queryDOB", 10000);
                await page.fill("#queryDOB", patientDob.trim());

                await retrySelector(page, "#queryID", 10000);
                await page.fill("#queryID", memberId);

                const findMemberBtn = page.locator('input[value="Find Member"]').first();
                await Promise.all([
                    page.waitForSelector('table.Listing[summary="matching members"] tbody tr', { timeout: 30000 }),
                    findMemberBtn.click()
                ]);

                const loader = page.locator("#resultLoading");
                await loader.waitFor({ state: "hidden", timeout: 40000 }).catch(() => { });

                // Check search results
                const resultsTable = page.locator('table.Listing[summary="matching members"] tbody tr');
                if (await resultsTable.count() === 0) {
                    console.log(`⚠️ No records found for ${memberId}`);
                    await updateProgress(db, row._id, "No records found");
                    continue;
                }

                // Open member details page
                const detailPage = await context.newPage();
                await detailPage.goto(`https://eservices.uph.org/Member/Details/${memberId}`, { waitUntil: "domcontentloaded" });
                await detailPage.waitForSelector("#div_Results", { timeout: 10000 }).catch(() => { });

                const memberDetails = {};

                // Extract Provider + Practice
                const providerName = await getFieldValueByLabel(detailPage, "#div_Results", "Provider Name");
                if (providerName) memberDetails["Provider Name"] = providerName;

                const practiceName = await getFieldValueByLabel(detailPage, "#div_Results", "Practice Name");
                if (practiceName) memberDetails["Practice Name"] = practiceName;

                // Extract plan table
                const planTable = detailPage.locator('table.DetailsSub', { has: detailPage.locator('th:has-text("Health Plan")') });
                const hasPlanTable = await planTable.isVisible().catch(() => false);

                let hasActivePlan = false;
                let activeEffectiveDate = "";

                if (hasPlanTable) {
                    const planRows = planTable.locator("tbody tr");
                    const planCount = await planRows.count();

                    for (let i = 0; i < planCount; i++) {
                        const tds = planRows.nth(i).locator("td");
                        if (await tds.count() < 2) continue;

                        const healthPlan = (await tds.nth(1).innerText()).trim();
                        const effectiveDate = (await tds.nth(2).innerText()).trim();
                        const className = await planRows.nth(i).getAttribute("class");
                        const isActive = className && className.includes("text-active");

                        if (isActive && !hasActivePlan) {
                            hasActivePlan = true;
                            activeEffectiveDate = effectiveDate;
                        }

                        memberDetails["Health Plan"] = healthPlan;
                    }
                }

                // Save remarks
                if (!hasActivePlan) {
                    memberDetails["Remarks"] = "Banner Inactive for This DOS";
                    await updateProgress(db, row._id, "Banner Inactive for This DOS");
                } else {
                    const planType = memberId.startsWith("A") ? "MCD HMO Plan" : "MCR HMO Plan";
                    const ovChemoInj = memberId.startsWith("A")
                        ? "OV/Chemo & Inj covers 100% of Medical Allowances"
                        : "OV/Chemo & Inj covers 80% of Medical Allowances and 20% Coins";

                    const remarks = `Member ID ${memberId}, Payer Name ${payerName}, Eff Date ${activeEffectiveDate}, Plan Name ${planType}, Referral required from PCP ${memberDetails["Provider Name"] || "N/A"}, ${ovChemoInj}`;

                    memberDetails["Remarks"] = remarks;
                    await updateProgress(db, row._id, remarks);
                }

                console.log(`✅ Done: ${memberId}`);
                await detailPage.close();

            } catch (err) {
                console.error(`❌ Error processing ${memberId}: ${err.message}`);
                await updateProgress(db, row._id, "Error during processing");
            }
        }

    } catch (err) {
        console.error("❌ Scraper failed:", err.message);
    } finally {
        await browser.close();
    }
}

module.exports = { runScraper };
