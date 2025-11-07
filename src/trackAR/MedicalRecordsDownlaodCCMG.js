const { MongoClient, ObjectId } = require("mongodb");
const { chromium } = require("playwright");
const path = require("path");
const moment = require("moment");
const fs = require("fs");
const Client = require("ssh2-sftp-client");
const MongoURL = "mongodb+srv://scioms:5NHRcnbEjLaXefKF@scioms.n5hcu.mongodb.net/scio?retryWrites=true&w=majority";
const downloadsDir = path.join(__dirname, "downloads");

// ---------------- Robust Activity Monitor ----------------
class RobustActivityMonitor {
    constructor(page, workerId) {
        this.page = page;
        this.workerId = workerId;
        this.lastActivity = Date.now();
        this.isActive = true;
        this.monitorInterval = null;
        this.forceRefreshCount = 0;
        this.maxForceRefreshes = 5;
    }

    startMonitoring() {
        console.log(`🔍 Starting activity monitor for Worker ${this.workerId}`);

        // Track all possible page activities
        const activities = ['response', 'request', 'console', 'load', 'domcontentloaded', 'framenavigated'];
        activities.forEach(event => {
            this.page.on(event, () => this.recordActivity());
        });

        // External heartbeat to ensure monitor itself doesn't freeze
        this.monitorInterval = setInterval(() => {
            this.checkActivity();
        }, 3000); // Check every 3 seconds
    }

    recordActivity() {
        this.lastActivity = Date.now();
        this.forceRefreshCount = 0; // Reset force refresh counter on any activity
    }

    async checkActivity() {
        const inactiveTime = Date.now() - this.lastActivity;

        if (inactiveTime > 8000) { // 8 seconds inactive
            console.log(`🔄 Worker ${this.workerId} inactive for ${inactiveTime}ms, checking page state...`);

            try {
                // First, try a simple JavaScript execution to check if page is responsive
                const isResponsive = await this.page.evaluate(() => {
                    return typeof window !== 'undefined' && document.readyState === 'complete';
                }).catch(() => false);

                if (!isResponsive) {
                    console.log(`❌ Worker ${this.workerId} page unresponsive, forcing refresh...`);
                    await this.forceRefresh();
                } else {
                    console.log(`✅ Worker ${this.workerId} page is responsive but inactive, refreshing...`);
                    await this.safeRefresh();
                }
            } catch (error) {
                console.log(`❌ Worker ${this.workerId} page check failed, forcing refresh...`);
                await this.forceRefresh();
            }
        }
    }

    async safeRefresh() {
        try {
            await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
            console.log(`✅ Worker ${this.workerId} safe refresh successful`);
            this.recordActivity();
        } catch (error) {
            console.log(`❌ Worker ${this.workerId} safe refresh failed, trying force refresh...`);
            await this.forceRefresh();
        }
    }

    async forceRefresh() {
        this.forceRefreshCount++;

        if (this.forceRefreshCount > this.maxForceRefreshes) {
            console.log(`🚨 Worker ${this.workerId} exceeded max refresh attempts, restarting worker...`);
            await this.restartWorker();
            return;
        }

        try {
            console.log(`🔄 Worker ${this.workerId} force refresh attempt ${this.forceRefreshCount}`);

            // Navigate to about:blank first to clear any stuck state
            await this.page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 });

            // Then navigate back to the original URL
            await this.page.goto(this.page.url(), {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });

            console.log(`✅ Worker ${this.workerId} force refresh successful`);
            this.recordActivity();
        } catch (error) {
            console.log(`❌ Worker ${this.workerId} force refresh failed:`, error.message);

            // If even force refresh fails, try to recreate the page
            await this.recreatePage();
        }
    }

    async recreatePage() {
        try {
            console.log(`🔄 Worker ${this.workerId} recreating page...`);
            const context = this.page.context();
            await this.page.close();

            this.page = await context.newPage();
            await this.page.goto(this.page.url(), {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            });

            console.log(`✅ Worker ${this.workerId} page recreated successfully`);
            this.recordActivity();

            // Restart monitoring for the new page
            this.restartMonitoring();
        } catch (error) {
            console.log(`🚨 Worker ${this.workerId} page recreation failed:`, error.message);
        }
    }

    async restartWorker() {
        console.log(`🔄 Worker ${this.workerId} performing full restart...`);
        this.stopMonitoring();
        // Note: Full worker restart would need to be handled by the main process
        throw new Error(`Worker ${this.workerId} requires full restart`);
    }

    restartMonitoring() {
        this.stopMonitoring();
        this.startMonitoring();
    }

    stopMonitoring() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
    }

    // Manual activity recording for critical operations
    recordManualActivity(operation) {
        console.log(`📝 Worker ${this.workerId} activity: ${operation}`);
        this.recordActivity();
    }
}

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

        await fs.promises.unlink(localPath);
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

// ---------------- Login Once ----------------
async function loginOnce() {
    const browser = await chromium.launch({ channel: "chrome", headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("https://secure72.oncoemr.com/Login", { waitUntil: "domcontentloaded" });
    await page.fill("#Email", "knixon@scioms.com");
    await page.fill('input[type="password"]', "Secure@2020");
    await page.click("#login-button");

    await page.waitForSelector("text=CCMG", { timeout: 15000 });
    await page.click("text=CCMG");

    await page.click("#find-patient-link");
    const currentUrl = page.url();
    const storagePath = path.join(__dirname, "onco-session.json");
    await context.storageState({ path: storagePath });

    console.log(`Login successful! Session saved. Logged-in URL: ${currentUrl}`);

    await browser.close();
    return { sessionPath: storagePath, loginUrl: currentUrl };
}

// ---------------- Worker Function ----------------
async function worker(records, workerId, page, db, loginUrl) {
    console.log(`🚀 Worker ${workerId} starting with ${records.length} records`);

    // Start robust activity monitoring
    const activityMonitor = new RobustActivityMonitor(page, workerId);
    activityMonitor.startMonitoring();

    try {
        await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
        activityMonitor.recordManualActivity("Page loaded");

        const noteRegex = /\b(follow\s*up|consult\s*note|lab\s*visits?|lab\s*results?|urine\s*protein)\b/i;

        // Process individual records instead of groups
        for (const record of records) {
            const labResults = [];
            let pdfProcessed = false; // Track if any PDF was processed

            try {
                const account = record.Account;
                const dateOfService = record.DateOfService;
                const targetDate = moment(dateOfService).format("MM/DD/YY");

                activityMonitor.recordManualActivity(`Processing record ${record._id} for patient ${account}`);

                // ---- Patient Search with Retry ----
                let frameHandle;
                let retryCount = 0;
                const maxRetries = 3;

                while (retryCount < maxRetries) {
                    try {
                        // Check for and remove modal backdrop if present
                        const backdrop = await page.$('div.modal-backdrop.fade.in');
                        if (backdrop) {
                            await page.evaluate(() => {
                                const backdrop = document.querySelector('div.modal-backdrop.fade.in');
                                if (backdrop) backdrop.remove();
                            });
                            await page.waitForTimeout(1000);
                        }

                        await page.click("#find-patient-link");
                        activityMonitor.recordManualActivity("Clicked find patient");

                        frameHandle = await page.waitForSelector("#find-patient-popup", {
                            timeout: 30000,
                            state: "attached"
                        });

                        await page.waitForTimeout(2000);
                        activityMonitor.recordManualActivity("Patient popup loaded");
                        break;
                    } catch (err) {
                        retryCount++;
                        console.log(`🔄 Worker ${workerId} retry ${retryCount} for patient popup`);
                        if (retryCount === maxRetries) throw err;
                        await page.waitForTimeout(3000);
                    }
                }

                const frame = await frameHandle.contentFrame();
                activityMonitor.recordManualActivity("Frame content loaded");

                await frame.fill("#txtRN", account);
                await frame.click("#btnFind");
                await frame.waitForSelector("#tblPatientList");

                // Check if patient was actually found
                const patientRows = await frame.$$("#tblPatientList tr");
                if (patientRows.length <= 1) { // Only header row or empty
                    console.log(`❌ Worker ${workerId} - Patient ${account} NOT FOUND`);
                    await updateProgress(db, record._id, "Patient Not Found");
                    continue; // Skip to next record
                }

                console.log(`✅ Worker ${workerId} - Patient ${account} FOUND`);
                await frame.click("#anc1");
                await page.waitForSelector("#find-patient-popup", { state: "detached" });
                activityMonitor.recordManualActivity("Patient selected");

                // ---- Documents ----
                await page.click('div[id="11"] a');
                activityMonitor.recordManualActivity("Clicked documents");
                await page.waitForSelector("#ddlTypes", { state: "visible" });
                await page.selectOption("#ddlTypes", { label: "--All--" });
                activityMonitor.recordManualActivity("Document filter applied");

                const totalCountText = await page.$eval(
                    'div[data-test="atrium-group"]:has(h2:has-text("Documents")) span.ml1',
                    el => el.innerText
                );
                const totalCountMatch = totalCountText.match(/\d+/);
                const totalCount = totalCountMatch ? parseInt(totalCountMatch[0], 10) : 0;

                // Check if any documents exist
                if (totalCount === 0) {
                    console.log(`❌ Worker ${workerId} - No documents found for patient ${account}`);
                    await updateProgress(db, record._id, "No Documents Found");
                    continue;
                }

                console.log(`📊 Worker ${workerId} - Found ${totalCount} documents for patient ${account}`);

                const seenNoteIds = new Set();
                let lastRowIndex = 0;
                const tableHandle = await page.$("#tblDocs");
                const box = await tableHandle.boundingBox();
                await page.mouse.move(box.x + box.width / 2, box.y + 10);
                activityMonitor.recordManualActivity("Started document scanning");

                while (seenNoteIds.size < totalCount) {
                    activityMonitor.recordManualActivity(`Scanning documents ${seenNoteIds.size}/${totalCount}`);

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
                        console.log("Checking:", rowData.name);

                        if (noteRegex.test(rowData.name)) {
                            console.log("✅ Matched:", rowData.name);
                            labResults.push(rowData);
                        }
                        seenNoteIds.add(rowData.noteid);
                    }

                    lastRowIndex = rows.length;
                    const prevCount = rows.length;

                    await page.keyboard.press("PageDown");
                    await page.waitForTimeout(800);
                    activityMonitor.recordManualActivity("Scrolled documents");

                    await page
                        .waitForFunction(
                            prev => document.querySelectorAll("#tblDocs tbody tr").length > prev,
                            prevCount,
                            { timeout: 3000 }
                        )
                        .catch(() => { });

                    if (seenNoteIds.size >= totalCount) break;
                }

                await updateDocumentList(db, record._id, labResults);
                activityMonitor.recordManualActivity("Updated document list");

                // Check if any matching documents found
                if (labResults.length === 0) {
                    console.log(`❌ Worker ${workerId} - No matching documents found for patient ${account}`);
                    await updateProgress(db, record._id, "No Matching Documents");
                    continue;
                }

                console.log(`✅ Worker ${workerId} - Found ${labResults.length} matching documents`);

                // Filter for target date documents
                const dateSpecificDocs = labResults.filter(d => d.visit_date === targetDate);
                console.log(`📅 Worker ${workerId} - ${dateSpecificDocs.length} documents match target date ${targetDate}`);

                // Check if any date-specific documents found
                if (dateSpecificDocs.length === 0) {
                    console.log(`❌ Worker ${workerId} - No documents found for target date ${targetDate}`);
                    await updateProgress(db, record._id, "No Records Found");
                    continue;
                }

                // Process PDFs for date-specific documents
                for (const doc of dateSpecificDocs) {
                    activityMonitor.recordManualActivity(`Processing document ${doc.name}`);

                    const checkboxSelector = `#cbxDoc_${doc.noteid}`;
                    const checkbox = await page.$(checkboxSelector);
                    if (!checkbox) continue;

                    await page.click(checkboxSelector);
                    activityMonitor.recordManualActivity("Checked document");

                    const [newTab] = await Promise.all([
                        page.context().waitForEvent("page"),
                        page.click('[data-test="print-fax-btn"]'),
                    ]);

                    const activePage = newTab || page;
                    await activePage.waitForLoadState("domcontentloaded");
                    activityMonitor.recordManualActivity("PDF tab opened");

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
                        `ClaimDocuments/CCMG/Medical records/${account}/${moment(dateOfService).format("YYYYMMDD")}/${path.basename(filePath)}`
                    );

                    await newTab.close();
                    pdfProcessed = true; // Mark that at least one PDF was processed
                    activityMonitor.recordManualActivity("Document processed successfully");
                }

                // Final status based on PDF processing
                if (pdfProcessed) {
                    await updateProgress(db, record._id, "Done");
                    console.log(`✅ Worker ${workerId} - PDFs successfully processed for record ${record._id}`);
                } else {
                    await updateProgress(db, record._id, "No Records Found");
                    console.log(`❌ Worker ${workerId} - No PDFs could be processed for record ${record._id}`);
                }

            } catch (err) {
                console.error(`❌ Worker ${workerId} failed on record ${record._id}`, err);
                await updateProgress(db, record._id, "Failed");
            }
        }
    } finally {
        // Always stop monitoring when worker finishes
        activityMonitor.stopMonitoring();
    }

    console.log(`✅ Worker ${workerId} finished`);
}

// ---------------- Master Runner ----------------
async function runAutomation() {
    const { sessionPath, loginUrl } = await loginOnce();

    const mongoClient = new MongoClient(MongoURL);
    await mongoClient.connect();
    const db = mongoClient.db();

    // Get individual records (NO GROUPING) to avoid duplicates
    const allRecords = await db.collection("aiclaimmasters").find({
        NeedToCheck: "Yes",
        PracticeId: new ObjectId("641be9089ab39a2f9fff3239")
    }).sort({ DateOfService: -1 }).toArray();

    console.log(`📊 Total individual records to process: ${allRecords.length}`);

    // Debug: Check for duplicate accounts
    const accountSet = new Set();
    const duplicateAccounts = [];

    allRecords.forEach(record => {
        const account = record.Account;
        if (accountSet.has(account)) {
            duplicateAccounts.push(account);
        }
        accountSet.add(account);
    });

    if (duplicateAccounts.length > 0) {
        console.log(`⚠️  Found ${duplicateAccounts.length} duplicate patient accounts in database`);
    }

    if (allRecords.length == 0) {
        console.log("No Records Found");
        return true;
    }

    const workerCount = allRecords.length < 4 ? allRecords.length : 4;

    const browser = await chromium.launch({ channel: "chrome", headless: false });
    const context = await browser.newContext({ storageState: sessionPath });

    const pages = await Promise.all(Array.from({ length: workerCount }, () => context.newPage()));

    const chunkSize = Math.ceil(allRecords.length / workerCount);
    const chunks = [];
    for (let i = 0; i < allRecords.length; i += chunkSize) {
        chunks.push(allRecords.slice(i, i + chunkSize));
    }

    // Debug: Show distribution
    chunks.forEach((chunk, idx) => {
        const accounts = chunk.map(r => r.Account);
        console.log(`👷 Worker ${idx + 1} gets ${chunk.length} records: ${accounts.join(', ')}`);
    });

    await Promise.all(
        chunks.map((chunk, idx) => worker(chunk, idx + 1, pages[idx], db, loginUrl))
    );

    await browser.close();
    await mongoClient.close();
    console.log("✅ All records processed");
}

if (require.main === module) runAutomation();