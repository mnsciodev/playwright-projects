const { MongoClient, ObjectId } = require("mongodb");
const { chromium } = require("playwright");
const path = require("path");
const moment = require("moment");
const fs = require("fs");
const Client = require("ssh2-sftp-client");
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');
const MongoURL = "mongodb+srv://scioms:5NHRcnbEjLaXefKF@scioms.n5hcu.mongodb.net/scio?retryWrites=true&w=majority";
const downloadsDir = path.join(__dirname, "downloads");

// ✅ Configure email transporter
const transporter = nodemailer.createTransport({
    host: "smtp.office365.com",
    port: 587,
    auth: {
        user: "trackar@scioms.com",
        pass: "Qow22964"
    }
});

// ✅ Email Reporting Class
class EmailReporter {
    constructor() {
        this.startTime = new Date();
        this.reportData = [];
        this.successCount = 0;
        this.failCount = 0;
        this.totalRecords = 0;
        this.retrySuccessCount = 0;
    }

    addRecord(account, patientName, status, startTime, endTime = null) {
        this.reportData.push({
            'Created Date': moment(startTime).format('YYYY-MM-DD HH:mm:ss'),
            'Patient Name': patientName,
            'Account Number': account,
            'Status': status,
            'End Date': endTime ? moment(endTime).format('YYYY-MM-DD HH:mm:ss') : 'In Progress'
        });
    }

    updateRecordStatus(account, status) {
        const record = this.reportData.find(r => r['Account Number'] === account);
        if (record) {
            record.Status = status;
            record['End Date'] = moment().format('YYYY-MM-DD HH:mm:ss');
            
            if (status === 'Done') this.successCount++;
            if (status === 'Failed') this.failCount++;
            if (status === 'Retry Success') this.retrySuccessCount++;
        }
    }

    generateExcel() {
        try {
            const worksheet = XLSX.utils.json_to_sheet(this.reportData);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Automation Report');
            
            // Auto-size columns
            const maxWidth = this.reportData.reduce((w, r) => Math.max(w, r['Patient Name']?.length || 0), 10);
            worksheet['!cols'] = [
                { wch: 20 }, // Created Date
                { wch: Math.max(maxWidth, 15) }, // Patient Name
                { wch: 15 }, // Account Number
                { wch: 20 }, // Status
                { wch: 20 }  // End Date
            ];
            
            const reportPath = path.join(__dirname, `automation_report_${moment().format('YYYYMMDD_HHmmss')}.xlsx`);
            XLSX.writeFile(workbook, reportPath);
            console.log(`📊 Excel report generated: ${reportPath}`);
            return reportPath;
        } catch (error) {
            console.error('❌ Error generating Excel report:', error);
            return null;
        }
    }

    async sendCompletionEmail(excelPath, retrySummary = '') {
        const endTime = new Date();
        const duration = moment(endTime).diff(moment(this.startTime), 'minutes');
        
        const mailOptions = {
            from: '"SCIO Automation OncoEMR Records" <trackar@scioms.com>',
            to: ["msakthivel@scioms.com"],
            cc: ['msakthivel@scioms.com'],
            subject: `OncoEMR Records Automation Report ${moment().format("MM/DD/YYYY")}`,
            html: `
                <h2>OncoEMR Automation Run Summary</h2>
                <p><b>Total Patients:</b> ${this.totalRecords}</p>
                <p><b>Successfully Processed:</b> ${this.successCount}</p>
                <p><b>Failed:</b> ${this.failCount}</p>
                ${this.retrySuccessCount > 0 ? `<p><b>Retry Success:</b> ${this.retrySuccessCount}</p>` : ''}
                ${retrySummary ? `<p><b>Retry Summary:</b> ${retrySummary}</p>` : ''}
                <hr/>
                <p><b>Start Time:</b> ${moment(this.startTime).format("MM/DD/YYYY HH:mm:ss")}</p>
                <p><b>End Time:</b> ${moment(endTime).format("MM/DD/YYYY HH:mm:ss")}</p>
                <p><b>Duration:</b> ${duration} minutes</p>
                <hr/>
                <p>📎 The detailed report is attached as an Excel file.</p>
                <p>This is an automated message from the SCIO Automation PlayWright.</p>
            `,
            attachments: excelPath ? [
                {
                    filename: 'OncoEMR_Automation_Report.xlsx',
                    path: excelPath
                }
            ] : []
        };

        try {
            await transporter.sendMail(mailOptions);
            console.info('✅ Completion email sent successfully');
            
            // Clean up Excel file after sending
            if (excelPath && fs.existsSync(excelPath)) {
                fs.unlinkSync(excelPath);
                console.log(`🗑️ Deleted temporary report file: ${excelPath}`);
            }
        } catch (err) {
            console.error('❌ Failed to send completion email:', err);
        }
    }

    setTotalRecords(count) {
        this.totalRecords = count;
    }
}

// Create global reporter instance
const emailReporter = new EmailReporter();

// ---------------- ENHANCED Activity Monitor ----------------
class EnhancedActivityMonitor {
    constructor(page, workerId) {
        this.page = page;
        this.workerId = workerId;
        this.lastActivity = Date.now();
        this.isActive = true;
        this.monitorInterval = null;
        this.forceRefreshCount = 0;
        this.maxForceRefreshes = 10;
        this.shuttingDown = false;
        this.isRefreshing = false;
        this.isDocumentScanning = false; // ✅ NEW: Track document scanning state
    }

    startMonitoring() {
        console.log(`🔍 Starting enhanced activity monitor for Worker ${this.workerId}`);
        
        const activities = ['response', 'request', 'console', 'load', 'domcontentloaded', 'framenavigated'];
        activities.forEach(event => {
            this.page.on(event, () => this.recordActivity());
        });

        this.monitorInterval = setInterval(() => {
            if (!this.shuttingDown) {
                this.checkActivity();
            }
        }, 3000);
    }

    recordActivity() {
        if (!this.shuttingDown && !this.isRefreshing) {
            this.lastActivity = Date.now();
            this.forceRefreshCount = 0;
        }
    }

    recordManualActivity(operation) {
        console.log(`📝 Worker ${this.workerId} activity: ${operation}`);
        this.recordActivity();
    }

    async checkActivity() {
        if (this.shuttingDown || this.isRefreshing || this.isDocumentScanning) {
            return; // ✅ DON'T check during document scanning
        }
        
        const inactiveTime = Date.now() - this.lastActivity;
        
        if (inactiveTime > 8000) {
            console.log(`🔄 Worker ${this.workerId} inactive for ${inactiveTime}ms, checking page state...`);
            
            try {
                const isResponsive = await this.page.evaluate(() => {
                    return typeof window !== 'undefined' && document.readyState === 'complete';
                }).catch(() => false);

                if (!isResponsive) {
                    console.log(`❌ Worker ${this.workerId} page unresponsive, forcing refresh...`);
                    await this.forceRefresh();
                } else {
                    console.log(`✅ Worker ${this.workerId} page is responsive but inactive, performing safe refresh...`);
                    await this.safeRefresh();
                }
            } catch (error) {
                if (error.message.includes('closed') && this.shuttingDown) return;
                console.log(`❌ Worker ${this.workerId} page check failed:`, error.message);
                await this.forceRefresh();
            }
        }
    }

    async safeRefresh() {
        if (this.shuttingDown || this.isRefreshing || this.isDocumentScanning) return;
        
        this.isRefreshing = true;
        try {
            console.log(`🔄 Worker ${this.workerId} performing safe refresh...`);
            await this.page.reload({ 
                waitUntil: 'domcontentloaded', 
                timeout: 20000 
            });
            console.log(`✅ Worker ${this.workerId} safe refresh successful`);
            this.recordActivity();
        } catch (error) {
            if (error.message.includes('closed') && this.shuttingDown) return;
            console.log(`❌ Worker ${this.workerId} safe refresh failed:`, error.message);
            await this.forceRefresh();
        } finally {
            this.isRefreshing = false;
        }
    }

    async forceRefresh() {
        if (this.shuttingDown || this.isRefreshing || this.isDocumentScanning) return;
        
        this.isRefreshing = true;
        this.forceRefreshCount++;
        
        if (this.forceRefreshCount > this.maxForceRefreshes) {
            console.log(`🚨 Worker ${this.workerId} exceeded max refresh attempts, forcing worker finish...`);
            this.isRefreshing = false;
            throw new Error(`Worker ${this.workerId} forced to finish due to excessive refreshes`);
        }

        try {
            console.log(`🔄 Worker ${this.workerId} force refresh attempt ${this.forceRefreshCount}/${this.maxForceRefreshes}`);
            
            await this.page.goto('about:blank', { 
                waitUntil: 'domcontentloaded', 
                timeout: 10000 
            });
            
            let targetUrl = this.page.url();
            if (!targetUrl || targetUrl === 'about:blank') {
                targetUrl = this.loginUrl;
            }
            
            await this.page.goto(targetUrl, { 
                waitUntil: 'domcontentloaded', 
                timeout: 20000 
            });
            
            console.log(`✅ Worker ${this.workerId} force refresh successful`);
            this.recordActivity();
        } catch (error) {
            if (error.message.includes('closed') && this.shuttingDown) return;
            console.log(`❌ Worker ${this.workerId} force refresh failed:`, error.message);
            await this.recreatePage();
        } finally {
            this.isRefreshing = false;
        }
    }

    async recreatePage() {
        if (this.shuttingDown) throw new Error('Shutdown in progress');
        
        this.isRefreshing = true;
        try {
            console.log(`🔄 Worker ${this.workerId} recreating page...`);
            const context = this.page.context();
            const currentUrl = this.page.url();
            
            await this.page.close();
            
            this.page = await context.newPage();
            await this.page.goto(currentUrl || this.loginUrl, { 
                waitUntil: 'domcontentloaded', 
                timeout: 25000 
            });
            
            console.log(`✅ Worker ${this.workerId} page recreated successfully`);
            this.recordActivity();
            this.restartMonitoring();
        } catch (error) {
            console.log(`🚨 Worker ${this.workerId} page recreation failed:`, error.message);
            throw error;
        } finally {
            this.isRefreshing = false;
        }
    }

    restartMonitoring() {
        const activities = ['response', 'request', 'console', 'load', 'domcontentloaded', 'framenavigated'];
        activities.forEach(event => {
            this.page.on(event, () => this.recordActivity());
        });
    }

    // ✅ NEW: Methods to control monitoring during document scanning
    startDocumentScanning() {
        this.isDocumentScanning = true;
        console.log(`⏸️ Worker ${this.workerId} - Activity monitoring PAUSED during document scanning`);
    }

    stopDocumentScanning() {
        this.isDocumentScanning = false;
        this.recordActivity('Document scanning completed');
        console.log(`▶️ Worker ${this.workerId} - Activity monitoring RESUMED`);
    }

    stopMonitoring() {
        console.log(`🛑 Stopping activity monitor for Worker ${this.workerId}`);
        this.shuttingDown = true;
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
    }

    setLoginUrl(loginUrl) {
        this.loginUrl = loginUrl;
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
    try {
        const collection = db.collection("aiclaimmasters");
        const _id = typeof recordId === "string" ? new ObjectId(recordId) : recordId;
        await collection.updateOne({ _id }, { $set: { NeedToCheck: "No", Status: message } });
        console.log(`✅ Updated record ${recordId} status to: ${message}`);
    } catch (error) {
        console.error(`❌ Failed to update record ${recordId}:`, error.message);
    }
}

async function updateDocumentList(db, recordId, DocumentList) {
    try {
        const collection = db.collection("aiclaimmasters");
        const _id = typeof recordId === "string" ? new ObjectId(recordId) : recordId;
        await collection.updateOne({ _id }, { $set: { NeedToCheck: "No", DocumentList: DocumentList } });
        console.log(`✅ Updated document list for record ${recordId}`);
    } catch (error) {
        console.error(`❌ Failed to update document list for record ${recordId}:`, error.message);
    }
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

    console.log(`✅ Login successful! Session saved. Logged-in URL: ${currentUrl}`);

    await browser.close();
    return { sessionPath: storagePath, loginUrl: currentUrl };
}

// ---------------- Worker Function ----------------
async function worker(records, workerId, page, db, loginUrl, isRetry = false) {
    console.log(`🚀 Worker ${workerId} starting with ${records.length} records ${isRetry ? '(RETRY)' : ''}`);
    
    const activityMonitor = new EnhancedActivityMonitor(page, workerId);
    activityMonitor.setLoginUrl(loginUrl);
    activityMonitor.startMonitoring();

    try {
        await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        activityMonitor.recordManualActivity("Page loaded successfully");

        const noteRegex = /\b(follow\s*up|consult\s*note|lab\s*visits?|lab\s*results?|urine\s*protein)\b/i;

        for (const record of records) {
            let account = '';
            const labResults = [];
            let pdfProcessed = false;
            const startTime = new Date();
            
            try {
                account = record.Account;
                const dateOfService = record.DateOfService;
                const targetDate = moment(dateOfService).format("MM/DD/YY");
                const patientName = record.PatientName || 'Unknown';

                if (!isRetry) {
                    emailReporter.addRecord(account, patientName, 'Started', startTime);
                }
                activityMonitor.recordManualActivity(`Processing record ${record._id} for patient ${account}`);

                // ---- Patient Search with Retry ----
                let frameHandle;
                let retryCount = 0;
                const maxRetries = 3;

                while (retryCount < maxRetries) {
                    try {
                        activityMonitor.recordManualActivity(`Patient search attempt ${retryCount + 1}`);
                        
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
                        console.log(`🔄 Worker ${workerId} retry ${retryCount} for patient popup: ${err.message}`);
                        if (retryCount === maxRetries) {
                            throw new Error(`Failed to load patient popup after ${maxRetries} attempts`);
                        }
                        await page.waitForTimeout(3000);
                    }
                }

                const frame = await frameHandle.contentFrame();
                activityMonitor.recordManualActivity("Frame content loaded");

                await frame.fill("#txtRN", account);
                await frame.click("#btnFind");
                await frame.waitForSelector("#tblPatientList", { timeout: 15000 });
                
                const patientRows = await frame.$$("#tblPatientList tr");
                if (patientRows.length <= 1) {
                    console.log(`❌ Worker ${workerId} - Patient ${account} NOT FOUND`);
                    await updateProgress(db, record._id, "Patient Not Found");
                    if (!isRetry) {
                        emailReporter.updateRecordStatus(account, "Patient Not Found");
                    }
                    continue;
                }
                
                console.log(`✅ Worker ${workerId} - Patient ${account} FOUND`);
                await frame.click("#anc1");
                await page.waitForSelector("#find-patient-popup", { state: "detached", timeout: 10000 });
                activityMonitor.recordManualActivity("Patient selected");

                // ---- Documents ----
                await page.click('div[id="11"] a');
                activityMonitor.recordManualActivity("Clicked documents");
                await page.waitForSelector("#ddlTypes", { state: "visible", timeout: 15000 });
                await page.selectOption("#ddlTypes", { label: "--All--" });
                activityMonitor.recordManualActivity("Document filter applied");

                const totalCountText = await page.$eval(
                    'div[data-test="atrium-group"]:has(h2:has-text("Documents")) span.ml1',
                    el => el.innerText
                );
                const totalCountMatch = totalCountText.match(/\d+/);
                const totalCount = totalCountMatch ? parseInt(totalCountMatch[0], 10) : 0;

                if (totalCount === 0) {
                    console.log(`❌ Worker ${workerId} - No documents found for patient ${account}`);
                    await updateProgress(db, record._id, "No Documents Found");
                    if (!isRetry) {
                        emailReporter.updateRecordStatus(account, "No Documents Found");
                    }
                    continue;
                }

                console.log(`📊 Worker ${workerId} - Found ${totalCount} documents for patient ${account}`);

                const seenNoteIds = new Set();
                let lastRowIndex = 0;
                
                // ✅ CRITICAL: PAUSE ACTIVITY MONITORING DURING DOCUMENT SCANNING
                activityMonitor.startDocumentScanning();
                
                try {
                    activityMonitor.recordManualActivity("Started document scanning");

                    while (seenNoteIds.size < totalCount) {
                        console.log(`📄 Worker ${workerId} - Scanning documents ${seenNoteIds.size}/${totalCount}`);
                        
                        let rows = [];
                        try {
                            rows = await page.$$("#tblDocs tbody tr");
                        } catch (err) {
                            console.log(`⚠️ Worker ${workerId} - Page context lost during scanning, attempting recovery...`);
                            try {
                                await page.reload({ waitUntil: 'domcontentloaded' });
                                await page.click('div[id="11"] a');
                                await page.waitForSelector("#ddlTypes", { state: "visible" });
                                await page.selectOption("#ddlTypes", { label: "--All--" });
                                rows = await page.$$("#tblDocs tbody tr");
                                console.log(`✅ Worker ${workerId} - Successfully recovered from page context loss`);
                                } catch (recoveryErr) {
                                console.log(`❌ Worker ${workerId} - Recovery failed, marking as failed and continuing to next patient`);
                                break;
                            }
                        }

                        if (rows.length === 0) {
                            console.log(`⚠️ Worker ${workerId} - No rows found after recovery, skipping document scanning`);
                            break;
                        }

                        for (let i = lastRowIndex; i < rows.length; i++) {
                            let rowData;
                            try {
                                rowData = await rows[i].evaluate(el => {
                                    const noteid = el.getAttribute("noteid") || "";
                                    if (!noteid) return null;
                                    return {
                                        noteid,
                                        visit_date: el.querySelector(".doc-list-visit-date")?.innerText.trim() || "",
                                        category: el.querySelector(".doc-list-category")?.innerText.trim() || "",
                                        name: el.querySelector(".doc-list-doc-name a")?.innerText.trim() || "",
                                    };
                                });
                            } catch (err) {
                                console.log(`⚠️ Worker ${workerId} - Error evaluating row ${i}, skipping`);
                                continue;
                            }

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

                        try {
                            await page.keyboard.press("PageDown");
                            await page.waitForTimeout(800);
                            console.log(`📄 Worker ${workerId} - Scrolled to load more documents`);

                            await page
                                .waitForFunction(
                                    prev => document.querySelectorAll("#tblDocs tbody tr").length > prev,
                                    prevCount,
                                    { timeout: 3000 }
                                )
                                .catch(() => { });
                        } catch (err) {
                            console.log(`⚠️ Worker ${workerId} - Scrolling/wait function failed, continuing...`);
                        }

                        if (seenNoteIds.size >= totalCount) break;
                    }
                } finally {
                    // ✅ CRITICAL: RESUME ACTIVITY MONITORING AFTER DOCUMENT SCANNING
                    activityMonitor.stopDocumentScanning();
                }

                await updateDocumentList(db, record._id, labResults);
                activityMonitor.recordManualActivity("Updated document list");

                if (labResults.length === 0) {
                    console.log(`❌ Worker ${workerId} - No matching documents found for patient ${account}`);
                    await updateProgress(db, record._id, "No Matching Documents");
                    if (!isRetry) {
                        emailReporter.updateRecordStatus(account, "No Matching Documents");
                    }
                    continue;
                }

                console.log(`✅ Worker ${workerId} - Found ${labResults.length} matching documents`);

                const dateSpecificDocs = labResults.filter(d => d.visit_date === targetDate);
                console.log(`📅 Worker ${workerId} - ${dateSpecificDocs.length} documents match target date ${targetDate}`);

                if (dateSpecificDocs.length === 0) {
                    console.log(`❌ Worker ${workerId} - No documents found for target date ${targetDate}`);
                    await updateProgress(db, record._id, "No Records Found");
                    if (!isRetry) {
                        emailReporter.updateRecordStatus(account, "No Records Found");
                    }
                    continue;
                }

                for (const doc of dateSpecificDocs) {
                    activityMonitor.recordManualActivity(`Processing document ${doc.name}`);
                    
                    const checkboxSelector = `#cbxDoc_${doc.noteid}`;
                    let checkbox;
                    try {
                        checkbox = await page.$(checkboxSelector);
                    } catch (err) {
                        console.log(`⚠️ Worker ${workerId} - Error finding checkbox for ${doc.name}, skipping`);
                        continue;
                    }
                    
                    if (!checkbox) continue;

                    try {
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

                        if (newTab) {
                            await newTab.close();
                        }
                        pdfProcessed = true;
                        activityMonitor.recordManualActivity("Document processed successfully");
                    } catch (err) {
                        console.log(`⚠️ Worker ${workerId} - Error processing PDF for ${doc.name}, continuing to next document`);
                        continue;
                    }
                }

                if (pdfProcessed) {
                    if (isRetry) {
                        await updateProgress(db, record._id, "Retry Success");
                        emailReporter.updateRecordStatus(account, "Retry Success");
                        console.log(`🎉 Worker ${workerId} - RETRY SUCCESS for record ${record._id}`);
                    } else {
                        await updateProgress(db, record._id, "Done");
                        emailReporter.updateRecordStatus(account, "Done");
                        console.log(`✅ Worker ${workerId} - PDFs successfully processed for record ${record._id}`);
                    }
                } else {
                    await updateProgress(db, record._id, "No Records Found");
                    if (!isRetry) {
                        emailReporter.updateRecordStatus(account, "No Records Found");
                    }
                    console.log(`❌ Worker ${workerId} - No PDFs could be processed for record ${record._id}`);
                }

            } catch (err) {
                console.error(`❌ Worker ${workerId} failed on record ${record._id} for patient ${account || 'Unknown'}:`, err.message);
                try {
                    await updateProgress(db, record._id, "Failed");
                    if (account && !isRetry) {
                        emailReporter.updateRecordStatus(account, "Failed");
                    }
                } catch (dbErr) {
                    console.error(`⚠️ Worker ${workerId} - Failed to update database for record ${record._id}`);
                }
            }
        }
    } catch (error) {
        console.error(`🚨 Worker ${workerId} encountered fatal error:`, error.message);
    } finally {
        activityMonitor.stopMonitoring();
        try {
            await page.close();
            console.log(`🔒 Worker ${workerId} page closed successfully`);
        } catch (closeError) {
            console.log(`⚠️ Worker ${workerId} page already closed`);
        }
    }
    
    console.log(`✅ Worker ${workerId} finished processing all records`);
}

// ---------------- Get Failed Records ----------------
async function getFailedRecords(db) {
    const failedRecords = await db.collection("aiclaimmasters").find({
        NeedToCheck: "No",
        Status: "Failed",
        PracticeId: new ObjectId("641be9089ab39a2f9fff3239")
    }).toArray();
    
    console.log(`🔄 Found ${failedRecords.length} failed records to retry`);
    return failedRecords;
}

// ---------------- Master Runner with Auto-Retry ----------------
async function runAutomation() {
    console.log('🚀 Starting automation with AUTO-RETRY logic...');
    
    const { sessionPath, loginUrl } = await loginOnce();

    const mongoClient = new MongoClient(MongoURL);
    await mongoClient.connect();
    const db = mongoClient.db();
    
    // ✅ FIRST RUN: Get records with NeedToCheck: "Yes"
    const allRecords = await db.collection("aiclaimmasters").find({
        NeedToCheck: "Yes", 
        PracticeId: new ObjectId("641be9089ab39a2f9fff3239")
    }).sort({ DateOfService: -1 }).toArray();

    console.log(`📊 Total records to process: ${allRecords.length}`);
    
    const uniqueAccounts = [...new Set(allRecords.map(r => r.Account))];
    console.log(`🔍 Unique patient accounts: ${uniqueAccounts.length}`);
    
    if (allRecords.length !== uniqueAccounts.length) {
        console.log(`⚠️  Found ${allRecords.length - uniqueAccounts.length} duplicate records`);
    }

    emailReporter.setTotalRecords(allRecords.length);
    
    if (allRecords.length == 0) {
        console.log("No Records Found");
        await emailReporter.sendCompletionEmail(null);
        await mongoClient.close();
        return;
    }
    
    // First Run - process all records with NeedToCheck: "Yes"
    await runWorkerBatch(allRecords, db, loginUrl, sessionPath, false);
    
    // ✅ AUTO-RETRY: Get failed records (NeedToCheck: "No", Status: "Failed")
    const failedRecords = await getFailedRecords(db);
    
    let retrySummary = '';
    if (failedRecords.length > 0) {
        console.log(`🔄 Starting AUTO-RETRY for ${failedRecords.length} failed records...`);
        const retrySuccessCount = await runWorkerBatch(failedRecords, db, loginUrl, sessionPath, true);
        retrySummary = `Auto-retried ${failedRecords.length} failed records, ${retrySuccessCount} succeeded`;
    } else {
        retrySummary = 'No failed records to retry';
    }
    
    await mongoClient.close();
    
    // Generate final report and send email
    const excelPath = emailReporter.generateExcel();
    await emailReporter.sendCompletionEmail(excelPath, retrySummary);
    
    console.log("✅ All records processed and email report sent");
}

// ---------------- Run Worker Batch ----------------
async function runWorkerBatch(records, db, loginUrl, sessionPath, isRetry = false) {
    const workerCount = Math.min(8, records.length);
    console.log(`👷 Starting ${workerCount} workers for ${records.length} records ${isRetry ? '(RETRY)' : ''}`);

    const browser = await chromium.launch({ channel: "chrome", headless: false });
    const context = await browser.newContext({ storageState: sessionPath });
    
    const pages = await Promise.all(Array.from({ length: workerCount }, () => context.newPage()));

    const chunkSize = Math.ceil(records.length / workerCount);
    const chunks = [];
    for (let i = 0; i < records.length; i += chunkSize) {
        chunks.push(records.slice(i, i + chunkSize));
    }

    const workerPromises = chunks.map((chunk, idx) => 
        Promise.race([
            worker(chunk, idx + 1, pages[idx], db, loginUrl, isRetry),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error(`Worker ${idx + 1} timeout after 45 minutes`)), 45 * 60 * 1000)
            )
        ]).catch(error => {
            console.error(`🚨 Worker ${idx + 1} failed:`, error.message);
            try {
                pages[idx].close().catch(() => {});
            } catch (e) {}
            return `Worker ${idx + 1} completed with errors`;
        })
    );

    try {
        await Promise.all(workerPromises);
        console.log(`🎉 All workers completed their tasks ${isRetry ? '(RETRY)' : ''}`);
    } catch (error) {
        console.error('❌ Some workers failed:', error);
    } finally {
        console.log('🔒 Closing browser...');
        await browser.close();
    }

    // Count retry successes
    if (isRetry) {
        return emailReporter.retrySuccessCount;
    }
    return 0;
}

if (require.main === module) runAutomation();