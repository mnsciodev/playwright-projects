const { MongoClient, ObjectId } = require("mongodb");
const { chromium } = require("playwright");
const path = require("path");
const moment = require("moment");
const fs = require("fs");
const Client = require("ssh2-sftp-client");
const MongoURL = "mongodb+srv://scioms:5NHRcnbEjLaXefKF@scioms.n5hcu.mongodb.net/scio?retryWrites=true&w=majority";
const downloadsDir = path.join(__dirname, "downloads");
// ---------------- SFTP Upload ----------------
async function uploadToSFTP(localPath, remotePath) {
    const sftp = new Client();
    const remoteDir = remotePath.substring(0, remotePath.lastIndexOf("/"));
    try {
        await sftp.connect({
            host: "66.185.27.40",
            port: 22,
            username: "sciomstrackar",
            password: "dR35g?FlxmNC",
        });
        const exists = await sftp.exists(remoteDir);
        if (!exists) {
            await sftp.mkdir(remoteDir, true);
            console.log(`📁 Created remote directory: ${remoteDir}`);
        } else {
            console.log(`📁 Remote directory already exists: ${remoteDir}`);
        }
        await sftp.put(localPath, remotePath);

        // Optional: delete local file after upload
        await fs.promises.unlink(localPath);
        // console.log(`🗑️ Deleted local file: ${localPath}`);
    } catch (err) {
        console.error(`❌ SFTP error for ${localPath}:`, err.message);
    } finally {
        sftp.end();
    }
}
// ---------------- MongoDB Update ----------------
async function updateProgress(db, recordId, message) {
    const collection = db.collection("aiclaimmasters");
    const _id = typeof recordId === "string" ? new ObjectId(recordId) : recordId;
    await collection.updateOne({ _id }, { $set: { NeedToCheck: "No", Status: message } });
}
async function updateDocumentList(db, recordId, DocumentList) {
    const collection = db.collection("aiclaimmasters");
    const _id = typeof recordId === "string" ? new ObjectId(recordId) : recordId;
    await collection.updateOne({ _id }, { $set: { NeedToCheck: "No", DocumentList: DocumentList } });
}

// ----------------` Login Once ----------------
async function loginOnce() {
    const browser = await chromium.launch({ channel: "chrome",headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("https://secure4.oncoemr.com/Login", { waitUntil: "domcontentloaded" });
    await page.fill("#Email", "bencho@scioms.com");
    await page.fill('input[type="password"]', "Welcome@19");
    await page.click("#login-button");

    await page.waitForSelector("text=Bayfront", { timeout: 15000 });
    await page.click("text=Bayfront");

    await page.click("#find-patient-link");
    const currentUrl = page.url();
    const storagePath = path.join(__dirname, "onco-session.json");
    await context.storageState({ path: storagePath });

    console.log(`Login successful! Session saved. Logged-in URL: ${currentUrl}`);

    await browser.close();
    return { sessionPath: storagePath, loginUrl: currentUrl };
}

// ---------------- Worker Function ----------------
// ---------------- Worker Function (Updated for Grouped Records) ----------------
async function worker(groups, workerId, page, db, loginUrl) {
    console.log(`🚀 Worker ${workerId} starting with ${groups.length} groups`);

    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

    const noteRegex = /\b(follow\s*up|consult\s*note|lab\s*visits?|lab\s*results?|urine\s*protein)\b/i;

    for (const group of groups) {
        const groupAccount = group._id.Account;
        const groupDate = group._id.DateOfService;

        const targetDate = moment(groupDate).format("MM/DD/YY");
        const labResults = [];
        for (const record of group.records) {
            try {
                // ---- Patient Search ----
                await page.click("#find-patient-link");
                const frameHandle = await page.waitForSelector("#find-patient-popup");
                const frame = await frameHandle.contentFrame();

                await frame.fill("#txtRN", groupAccount);
                await frame.click("#btnFind");
                await frame.waitForSelector("#tblPatientList");
                await frame.click("#anc1");
                await page.waitForSelector("#find-patient-popup", { state: "detached" });

                // ---- Documents ----
                await page.click('[id="11"] a[href*="documents"]');
                await page.waitForSelector("#ddlTypes", { state: "visible" });
                await page.selectOption("#ddlTypes", { label: "--All--" });

                const totalCountText = await page.$eval(
                    'div[data-test="atrium-group"]:has(h2:has-text("Documents")) span.ml1',
                    el => el.innerText
                );
                const totalCountMatch = totalCountText.match(/\d+/);
                const totalCount = totalCountMatch ? parseInt(totalCountMatch[0], 10) : 0;

                const seenNoteIds = new Set();

                let lastRowIndex = 0;
                const tableHandle = await page.$("#tblDocs");
                const box = await tableHandle.boundingBox();
                await page.mouse.move(box.x + box.width / 2, box.y + 10);


                while (seenNoteIds.size < totalCount) {
                    const rows = await page.$$("#tblDocs tbody tr");

                    for (let i = lastRowIndex; i < rows.length; i++) {
                        const rowData = await rows[i].evaluate(el => {
                            const noteid = el.getAttribute("noteid") || "";
                            if (!noteid) return null;
                            return {
                                noteid,
                                visit_date: el.querySelector(".doc-list-visit-date")?.innerText.trim() || "",
                                category: el.querySelector(".doc-list-category")?.innerText.trim() || "",
                                name: el.querySelector(".doc-list-doc-name a")?.innerText.trim() || "",
                            };
                        });

                        if (!rowData || seenNoteIds.has(rowData.noteid)) continue;

                        // Debugging
                        console.log("Checking:", rowData.name);

                        if (noteRegex.test(rowData.name)) {
                            console.log("✅ Matched:", rowData.name);
                            labResults.push(rowData);
                        } else {
                        }

                        seenNoteIds.add(rowData.noteid);
                    }

                    lastRowIndex = rows.length;
                    const prevCount = rows.length;

                    // 🔽 Instead of mouse.wheel, press "PageDown"
                    await page.keyboard.press("PageDown");
                    await page.waitForTimeout(800); // wait a bit for new rows to load

                    // wait for more rows to appear
                    await page
                        .waitForFunction(
                            prev => document.querySelectorAll("#tblDocs tbody tr").length > prev,
                            prevCount,
                            { timeout: 3000 }
                        )
                        .catch(() => { });

                    if (seenNoteIds.size >= totalCount) break;
                }

                updateDocumentList(db, record._id, labResults)
                for (const doc of labResults.filter(d => d.visit_date === targetDate)) {
                    const checkboxSelector = `#cbxDoc_${doc.noteid}`;
                    const checkbox = await page.$(checkboxSelector);
                    if (!checkbox) continue;

                    await page.click(checkboxSelector);

                    const [newTab] = await Promise.all([
                        page.context().waitForEvent("page"),
                        page.click('[data-test="print-fax-btn"]'),
                    ]);

                    const activePage = newTab || page;
                    await activePage.waitForLoadState("domcontentloaded");

                    const frameHandle = await activePage.waitForSelector("#frmPreview", { timeout: 15000 });
                    const pdfUrl = await frameHandle.getAttribute("src");
                    if (!pdfUrl) continue;

                    const pdfAbsoluteUrl = new URL(pdfUrl, activePage.url()).href;
                    const pdfResponse = await activePage.request.get(pdfAbsoluteUrl);
                    const pdfBuffer = await pdfResponse.body();

                    const filePath = path.join(
                        downloadsDir,
                        `${doc.name.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}.pdf`
                    );
                    await fs.promises.writeFile(filePath, pdfBuffer);

                    await uploadToSFTP(
                        filePath,
                        `ClaimDocuments/CHO/Medical records/${groupAccount}/${moment(groupDate).format("YYYYMMDD")}/${path.basename(filePath)}`
                    );

                    await newTab.close();
                    await updateProgress(db, record._id, "Done");
                }
            } catch (err) {
                console.error(`❌ Worker ${workerId} failed on record ${record._id}`, err);
                await updateProgress(db, record._id, "Failed");
            }
        }
    }
    console.log(`✅ Worker ${workerId} finished`);
}
// ---------------- Master Runner ----------------
async function runAutomation() {
    const { sessionPath, loginUrl } = await loginOnce();

    const mongoClient = new MongoClient(MongoURL);
    await mongoClient.connect();
    const db = mongoClient.db();
    const allRecords = await db.collection("aiclaimmasters").aggregate([
        { $match: { NeedToCheck: "Yes" } },
        {
            $group: {
                _id: { Account: "$Account", DateOfService: "$DateOfService" },
                records: { $push: "$$ROOT" }
            }
        },
        { $sort: { "_id.DateOfService": -1 } }
    ]).toArray();


    if (allRecords.length == 0) {
        console.log("No Records Found");
        return true;
    }
    // ✅ One browser, one context (shared login session)
    const workerCount = allRecords.length < 4 ? allRecords.length : 4;

    const browser = await chromium.launch({  channel: "chrome", headless: false });
    const context = await browser.newContext({ storageState: sessionPath });
    // ✅ Create 4 tabs in same context
    const pages = await Promise.all(Array.from({ length: workerCount }, () => context.newPage()));

    const chunkSize = Math.ceil(allRecords.length / workerCount);
    const chunks = [];
    for (let i = 0; i < allRecords.length; i += chunkSize) {
        chunks.push(allRecords.slice(i, i + chunkSize));
    }

    // ✅ Run all workers concurrently (same browser, different tabs)
    await Promise.all(
        chunks.map((chunk, idx) => worker(chunk, idx + 1, pages[idx], db, loginUrl))
    );

    await browser.close();
    await mongoClient.close();
    console.log("✅ All records processed");
}

if (require.main === module) runAutomation();