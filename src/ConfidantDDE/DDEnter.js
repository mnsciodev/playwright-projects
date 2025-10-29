const { chromium } = require("playwright");
const mongoose = require("mongoose");
// const Config = require("../../api/config/dbconfig");
// const User = require("../../api/models/User"); 
// const Claim = require("../../api/models/Claim");

const Config = require("../Config/dbconfig");
const User = require("../models/User");
const Claim = require("../models/Claim");

(async () => {
  try {
  mongoose
    .connect(Config.mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 120000,
    })
    .then(() => console.log("✅ MongoDB connected successfully"))
    .catch((err) => console.error("❌ MongoDB connection error:", err.message));

    const users = await User.find({ Status: "Active" });
    console.log("Number of active users:", users.length);

    if (!users.length) {
      console.log("❌ No users found");
      return;
    }

    // Sequential processing of users
    for (const user of users) {
      try {
        console.log(`\n➡️ Logging in for user: ${user.Login}`);

        const browser = await chromium.launch({
          headless: false,
          channel: "chrome",
          args: ["--start-maximized"],
        });

        const context = await browser.newContext({ viewport: null });
        const page = await context.newPage();

        const loginUrl =
          "https://www.ctdssmap.com/CTPortal/Provider/Secure-Site?returnurl=%2fCTPortal%2fClaims%2fClaim-Inquiry";
        await page.goto(loginUrl, { waitUntil: "load" });

        await page.fill(
          "#dnn_ctr400_LoginPage_SearchPage_dataPanel_userName_0_mb_userName_0",
          user.Login
        );
        await page.fill(
          "#dnn_ctr400_LoginPage_SearchPage_dataPanel_password_0_mb_password_0",
          user.Password
        );
        await page.click(
          "#dnn_ctr400_LoginPage_SearchPage_dataPanel_LoginButton_0"
        );

        await page.waitForSelector('a[title="Claims"]', { timeout: 15000 });
        await page.hover('a[title="Claims"]');
        await page.waitForTimeout(1000);

        const inquiryLink = page.locator('a:has-text("Claim Inquiry")');
        await inquiryLink.waitFor({ state: "visible", timeout: 15000 });
        await inquiryLink.click();
        console.log(`📄 ${user.Login}: Navigated to Claim Inquiry`);

        await page.waitForSelector(
          "#dnn_ctr425_ClaimSearchPage_SearchPage_CriteriaPanel_ICN_0_mb_ICN_0",
          { state: "visible", timeout: 10000 }
        );

        await page.fill(
          "#dnn_ctr425_ClaimSearchPage_SearchPage_CriteriaPanel_ICN_0_mb_ICN_0",
          user.ICN.toString()
        );
        await page.click(
          "#dnn_ctr425_ClaimSearchPage_SearchPage_CriteriaPanel_SearchButton_0"
        );
        await page.waitForTimeout(2000);

        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.click("#dnn_ctr427_ClaimPhysicianInformation_NavFooter_CopyClaimButton"),
        ]);

        const claims = await Claim.find({
          renderingProviderName: user.ProviderName,
          process : "inactive",
        });

        console.log(
          `✅ Found ${claims.length} claims for provider: ${user.ProviderName}`
        );

        if (!claims.length) {
          console.log(`⚠️ No claims found for provider: ${user.ProviderName}`);
        }

        // Sequentially process all claims for this user
for (const claim of claims) {
  try {
    const medicaidIdSelector =
      "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Datapanel_ClaimRecipient\\.MedicaidID_0_mb_ClaimRecipient\\.MedicaidID_0";
    await page.waitForSelector(medicaidIdSelector, { timeout: 10000 });

    const isDisabled = await page.getAttribute(medicaidIdSelector, "disabled");
    if (isDisabled === null) {
      const memberId = claim.primaryMemberId?.toString().padStart(9, "0") || "";
      await page.fill(medicaidIdSelector, memberId);
      console.log(`🧾 Member ID filled: ${memberId}`);
    }

    const diagnosisCodeOriginal = (claim.diagnosisCodes || "").toString().trim();
    console.log("🔍 Diagnosis Code original (with dot):", diagnosisCodeOriginal);

    const diagnosisSelector =
      "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Diagnosis_Datapanel_diagnosis_1_0_ds_diagnosis_1_0_mb_ds_diagnosis_1_0";

    await page.click(diagnosisSelector, { timeout: 5000 });
    await page.fill(diagnosisSelector, "");
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");

    const forcedDiagnosisCode = diagnosisCodeOriginal.replace(/\./g, "");
    await page.keyboard.type(forcedDiagnosisCode, { delay: 100 });
    await page.dispatchEvent(diagnosisSelector, "input");
    await page.dispatchEvent(diagnosisSelector, "change");
    await page.waitForTimeout(500);
    console.log(`🧾 Diagnosis Code typed: ${diagnosisCodeOriginal}`);

    const procedureCode = claim.procedureCodes?.toString().trim();

    await page.evaluate((code) => {
      const rows = document.querySelectorAll("tr.iC_DataListItem");
      for (const row of rows) {
        const cell = row.cells[5];
        if (cell?.textContent.trim() === code) {
          cell.click();
          break;
        }
      }
    }, procedureCode);

    const formatDateToMMDDYYYY = (dateInput) => {
      if (!dateInput) return "";
      const dateObj = dateInput instanceof Date ? dateInput : new Date(dateInput);
      const month = String(dateObj.getMonth() + 1).padStart(2, "0");
      const day = String(dateObj.getDate()).padStart(2, "0");
      const year = dateObj.getFullYear();
      return `${month}/${day}/${year}`;
    };

    const firstServiceDateSelector =
      "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Detail_Datapanel_FirstServiceDate_0_mb_FirstServiceDate_0";
    const lastServiceDateSelector =
      "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Detail_Datapanel_LastServiceDate_0_mb_LastServiceDate_0";

    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        return el && !el.disabled;
      },
      firstServiceDateSelector,
      { timeout: 150000 }
    );

    const formattedServiceDate = formatDateToMMDDYYYY(claim.dateOfService);
    if (formattedServiceDate) {
      await page.fill(firstServiceDateSelector, formattedServiceDate);
      await page.fill(lastServiceDateSelector, formattedServiceDate);
      console.log(`📅 Service Date filled: ${formattedServiceDate}`);
    }

    const procedureCodeSelector =
      "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Detail_Datapanel_Procedure_0_ds_Procedure_0_mb_ds_Procedure_0";
    if (procedureCode) {
      await page.fill(procedureCodeSelector, procedureCode);
      console.log(`💉 Procedure Code filled: ${procedureCode}`);
    }

    if (claim.sumChargeAmountDollars) {
      const amount = claim.sumChargeAmountDollars.toString().trim();
      await page.fill(
        "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Detail_Datapanel_BilledAmount_0_mb_BilledAmount_0",
        amount
      );
      console.log(`💰 Billed Amount filled: ${amount}`);
    }

    const saveButtonSelector = "#dnn_ctr427_ClaimPhysicianInformation_NavFooter_SaveButton";
    await page.waitForSelector(saveButtonSelector, { state: "attached", timeout: 120000 });
    await page.evaluate((selector) => {
      const btn = document.querySelector(selector);
      if (btn) btn.click();
      else throw new Error("Save button not found!");
    }, saveButtonSelector);
    await page.waitForLoadState("load", { timeout: 120000 });
    console.log("✅ Save clicked and page fully reloaded.");

    await Promise.all([
      page.waitForSelector(
        "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Status_Datapanel_Status_0_mb_Status_0",
        { timeout: 120000, state: "visible" }
      ),
      page.waitForSelector(
        "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Status_Datapanel_IcnNumber_0_mb_IcnNumber_0",
        { timeout: 120000, state: "visible" }
      ),
      page.waitForSelector(
        "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Status_Datapanel_PaidAmount_0_mb_PaidAmount_0",
        { timeout: 120000, state: "visible" }
      ),
    ]);

    const status = await page.inputValue(
      "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Status_Datapanel_Status_0_mb_Status_0"
    );
    const icn = await page.inputValue(
      "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Status_Datapanel_IcnNumber_0_mb_IcnNumber_0"
    );
    const paidAmount = await page.inputValue(
      "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Status_Datapanel_PaidAmount_0_mb_PaidAmount_0"
    );
    console.log(`📝 Status: ${status}, ICN: ${icn}, Paid Amount: ${paidAmount}`);

    let comment = "";
    if (status.toLowerCase() === "paid") {
      comment = `Claim was entered in DD & under claim# ${icn} for the payment of $${paidAmount}. Hence need to allow time to post the payment.`;
    } else if (status.toLowerCase() === "denied") {
      await page.waitForSelector(
        "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Status_EobList tr.iC_DataListItem, " +
          "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Status_EobList tr.iC_DataListAlternateItem",
        { timeout: 60000 }
      );
      const eobDescriptions = await page.$$eval(
        "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Status_EobList tr.iC_DataListItem, " +
          "#dnn_ctr427_ClaimPhysicianInformation_ctl01_Status_EobList tr.iC_DataListAlternateItem",
        (rows) =>
          rows
            .map((row) => {
              const cells = row.querySelectorAll("td");
              return cells[2]?.textContent.trim();
            })
            .filter((desc) => desc)
      );
      comment = `Claim was denied with the following EOB reasons:\n- ${eobDescriptions.join("\n- ")}`;
    }

    const currentDate = new Date();
    await Claim.updateOne(
      { _id: claim._id },
      {
        $set: {
          comments: comment,
          status: status,
          date: currentDate,
          user: "Pasupathy",
          process: "active",
        },
      }
    );

    // Navigate to copy or cancel based on result
    if (status.toLowerCase() === "paid") {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.click("#dnn_ctr427_ClaimPhysicianInformation_NavFooter_CopyClaimButton"),
      ]);
    } else if (status.toLowerCase() === "denied") {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.click("#dnn_ctr427_ClaimPhysicianInformation_NavFooter_CancelButton"),
      ]);
    }

    // const screenshotPath = `screenshots/claim_${claim._id}.png`;
    // await page.screenshot({ path: screenshotPath, fullPage: true });
    // console.log(`📸 Screenshot saved: ${screenshotPath}`);
  } catch (claimErr) {
    console.error(`❌ Error processing claim ${claim._id}:`, claimErr.message);
    const currentDate = new Date();
    await Claim.updateOne(
      { _id: claim._id },
      {
        $set: {
          process: "inactive",
          date: currentDate,
          user: "Pasupathy",
          comments: `Processing failed: ${claimErr.message}`,
        },
      }
    );
  }
  // await browser.close();
}
      } catch (err) {
        console.error(`❌ Error processing user ${user.Login}:`, err.message);
      }
    }
    console.log("✅ All users and their claims processed");
    process.exit(0);
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  }
})();
