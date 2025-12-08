const { chromium } = require('playwright');
const { MongoClient, ObjectId } = require("mongodb");
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');
const Client = require("ssh2-sftp-client");

const MongoURL = "mongodb+srv://scioms:5NHRcnbEjLaXefKF@scioms.n5hcu.mongodb.net/scio?retryWrites=true&w=majority";

// ✅ Configure email transporter
const transporter = nodemailer.createTransport({
    host: "smtp.office365.com",
    port: 587,
    auth: {
        user: "trackar@scioms.com",
        pass: "Qow22964"
    }
});

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
        console.log(`✅ Successfully uploaded to SFTP: ${remotePath}`);
    } catch (err) {
        console.error(`❌ SFTP error for ${localPath}:`, err.message);
    } finally {
        sftp.end();
    }
}

// ✅ Format DOS to YYYYMMDD
function formatDOS(dos) {
    try {
        if (!dos) return '00000000';
        
        // Try different date formats
        const date = moment(dos);
        if (date.isValid()) {
            return date.format('YYYYMMDD');
        }
        
        // Try parsing as MM/DD/YYYY
        const parts = dos.split('/');
        if (parts.length === 3) {
            const month = parts[0].padStart(2, '0');
            const day = parts[1].padStart(2, '0');
            const year = parts[2];
            return `${year}${month}${day}`;
        }
        
        return '00000000';
    } catch (error) {
        console.error(`❌ Error formatting DOS: ${dos}`, error.message);
        return '00000000';
    }
}

// ✅ Save file locally with new structure including DOS folder
async function saveFileLocallyWithStructure(claimNumber, fileType, sourcePath, rowId = null, dos = null) {
    try {
        // Format DOS
        const dosFolder = formatDOS(dos);
        
        // Define local paths based on file type
        let localDir;
        
        if (fileType === 'HCFA') {
            localDir = path.join(__dirname, 'ecw_downloads', 'HCFA', claimNumber, dosFolder);
        } 
        else if (fileType === 'PROGRESS_NOTE') {
            localDir = path.join(__dirname, 'ecw_downloads', 'Medical Records', claimNumber, dosFolder);
        }
        else if (fileType === 'ERA') {
            localDir = path.join(__dirname, 'ecw_downloads', 'EOB', claimNumber, dosFolder);
        }
        else {
            console.error(`❌ Unknown file type: ${fileType}`);
            return null;
        }
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(localDir)) {
            fs.mkdirSync(localDir, { recursive: true });
            console.log(`📁 Created local directory: ${localDir}`);
        }
        
        // ✅ Create filename with rowId if it exists
        const originalFileName = path.basename(sourcePath);
        let fileName = originalFileName;
        
        if (fileType === 'ERA' && rowId) {
            // Extract base name without extension
            const baseName = originalFileName.replace(/\.(pdf|html)$/, '');
            const extension = path.extname(originalFileName);
            
            // Check if rowId is already in filename
            if (!baseName.includes(`_row${rowId}`)) {
                // Insert rowId after claim number in filename
                const parts = baseName.split('_');
                for (let i = 0; i < parts.length; i++) {
                    if (parts[i].startsWith(claimNumber)) {
                        const newPart = `${parts[i]}_row${rowId}`;
                        parts[i] = newPart;
                        fileName = parts.join('_') + extension;
                        break;
                    }
                }
            }
        }
        
        const destinationPath = path.join(localDir, fileName);
        
        fs.copyFileSync(sourcePath, destinationPath);
        console.log(`💾 Saved locally: ${destinationPath}`);
        
        // Remove the original file from temp location
        fs.unlinkSync(sourcePath);
        
        return destinationPath;
        
    } catch (error) {
        console.error(`❌ Error saving file locally for claim ${claimNumber}:`, error.message);
        return null;
    }
}

// ✅ Upload single file to SFTP with new structure including DOS folder
async function uploadFileToSFTPWithStructure(claimNumber, fileType, localPath, rowId = null, dos = null) {
    try {
        // Format DOS
        const dosFolder = formatDOS(dos);
        
        // Define base paths for different file types
        let remotePath;
        
        // IMPORTANT: Get the filename from the local path (already properly formatted)
        const fileName = path.basename(localPath);
        
        if (fileType === 'HCFA') {
            remotePath = `ClaimDocuments/Arcadia Medical Associates PA/HCFA/${claimNumber}/${dosFolder}/${fileName}`;
        } 
        else if (fileType === 'PROGRESS_NOTE') {
            remotePath = `ClaimDocuments/Arcadia Medical Associates PA/Medical Records/${claimNumber}/${dosFolder}/${fileName}`;
        }
        else if (fileType === 'ERA') {
            remotePath = `ClaimDocuments/Arcadia Medical Associates PA/EOB/${claimNumber}/${dosFolder}/${fileName}`;
        }
        else {
            console.error(`❌ Unknown file type: ${fileType}`);
            return false;
        }
        
        console.log(`📤 Uploading ${fileType} to SFTP: ${remotePath}`);
        await uploadToSFTP(localPath, remotePath);
        return true;
    } catch (error) {
        console.error(`❌ Error uploading ${fileType} to SFTP for claim ${claimNumber}:`, error.message);
        return false;
    }
}

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

    addRecord(claimNumber, patientName, status, startTime, endTime = null) {
        this.reportData.push({
            'Created Date': moment(startTime).format('YYYY-MM-DD HH:mm:ss'),
            'Patient Name': patientName,
            'Claim Number': claimNumber,
            'Status': status,
            'End Date': endTime ? moment(endTime).format('YYYY-MM-DD HH:mm:ss') : 'In Progress'
        });
    }

    updateRecordStatus(claimNumber, status) {
        const record = this.reportData.find(r => r['Claim Number'] === claimNumber);
        if (record) {
            record.Status = status;
            record['End Date'] = moment().format('YYYY-MM-DD HH:mm:ss');
            
            if (status === 'Done') this.successCount++;
            if (status === 'Failed') this.failCount++;
            if (status.includes('Partially completed')) this.successCount++;
        }
    }

    generateExcel() {
        try {
            const worksheet = XLSX.utils.json_to_sheet(this.reportData);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, 'ECW Automation Report');
            
            const maxWidth = this.reportData.reduce((w, r) => Math.max(w, r['Patient Name']?.length || 0), 10);
            worksheet['!cols'] = [
                { wch: 20 },
                { wch: Math.max(maxWidth, 15) },
                { wch: 15 },
                { wch: 40 },
                { wch: 20 }
            ];
            
            const reportPath = path.join(__dirname, `ecw_automation_report_${moment().format('YYYYMMDD_HHmmss')}.xlsx`);
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
            from: '"SCIO Automation ECW Records" <trackar@scioms.com>',
            to: ["msakthivel@scioms.com"],
            cc: ['msakthivel@scioms.com'],
            subject: `ECW Records Automation Report ${moment().format("MM/DD/YYYY")}`,
            html: `
                <h2>ECW Automation Run Summary</h2>
                <p><b>Total Claims:</b> ${this.totalRecords}</p>
                <p><b>Successfully Processed:</b> ${this.successCount}</p>
                <p><b>Failed:</b> ${this.failCount}</p>
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
                    filename: 'ECW_Automation_Report.xlsx',
                    path: excelPath
                }
            ] : []
        };

        try {
            await transporter.sendMail(mailOptions);
            console.info('✅ Completion email sent successfully');
            
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

class ECWAutomation {
    constructor() {
        this.downloadsDir = path.join(__dirname, "ecw_downloads");
        this.emailReporter = new EmailReporter();
        this.ensureDownloadsDir();
    }

    ensureDownloadsDir() {
        if (!fs.existsSync(this.downloadsDir)) {
            fs.mkdirSync(this.downloadsDir, { recursive: true });
            console.log(`📁 Created main downloads directory: ${this.downloadsDir}`);
        }
    }

    // ✅ Create temp folder for initial downloads
    ensureTempFolder(claimNumber) {
        const tempFolder = path.join(this.downloadsDir, 'temp', claimNumber);
        if (!fs.existsSync(tempFolder)) {
            fs.mkdirSync(tempFolder, { recursive: true });
        }
        return tempFolder;
    }

    async connectToDatabase() {
        this.mongoClient = new MongoClient(MongoURL);
        await this.mongoClient.connect();
        this.db = this.mongoClient.db();
        console.log('✅ Connected to MongoDB');
    }

    async getRecordsToProcess() {
        const records = await this.db.collection("ecwmedicalrecords").find({
            NeedToCheck: "Yes"
        }).sort({ "SERVICE DATE": -1 }).toArray();
        
        console.log(`📊 Found ${records.length} records to process`);
        return records;
    }

    // ✅ Get failed records for retry
    async getFailedRecords() {
        const failedRecords = await this.db.collection("ecwmedicalrecords").find({
            NeedToCheck: "No",
            Status: "Failed"
        }).sort({ "SERVICE DATE": -1 }).toArray();
        
        console.log(`🔄 Found ${failedRecords.length} failed records to retry`);
        return failedRecords;
    }

    async updateRecordStatus(recordId, status, isRetry = false) {
        try {
            const collection = this.db.collection("ecwmedicalrecords");
            const _id = typeof recordId === "string" ? new ObjectId(recordId) : recordId;
            
            let finalStatus = status;
            
            await collection.updateOne({ _id }, { 
                $set: { 
                    NeedToCheck: "No", 
                    Status: finalStatus,
                    LastProcessed: new Date()
                } 
            });
            console.log(`✅ Updated record ${recordId} - Status: "${finalStatus}"`);
        } catch (error) {
            console.error(`❌ Failed to update record ${recordId}:`, error.message);
        }
    }

    // ✅ Check for License Expired Popup
    async checkForLicenseExpiredPopup(page, claimNumber) {
        try {
            // Look for the specific license expired popup
            const licensePopupSelector = '.modal-content:has-text("Claim\'s rendering Provider\'s license is expired")';
            
            const popupExists = await page.$(licensePopupSelector);
            if (popupExists && await popupExists.isVisible()) {
                console.log(`⚠️ LICENSE EXPIRED POPUP DETECTED for claim ${claimNumber}`);
                
                // Take screenshot for debugging (optional)
                const errorLogsDir = path.join(__dirname, 'error_logs');
                if (!fs.existsSync(errorLogsDir)) {
                    fs.mkdirSync(errorLogsDir, { recursive: true });
                }
                const screenshotPath = path.join(errorLogsDir, `license_expired_${claimNumber}_${Date.now()}.png`);
                await page.screenshot({ path: screenshotPath });
                console.log(`📸 Screenshot saved: ${screenshotPath}`);
                
                // Click the OK button
                const okButton = await page.$('button:has-text("OK")');
                if (okButton) {
                    await okButton.click();
                    console.log(`✅ Clicked OK on license expired popup`);
                    await page.waitForTimeout(1000);
                } else {
                    // Fallback: try to find any button in modal footer
                    const anyButton = await page.$('.modal-footer button');
                    if (anyButton) {
                        await anyButton.click();
                        console.log(`✅ Clicked available button on popup`);
                        await page.waitForTimeout(1000);
                    }
                }
                
                return true; // Popup was found and handled
            }
            
            return false; // No popup found
        } catch (error) {
            console.log(`ℹ️ Error checking for license popup: ${error.message}`);
            return false;
        }
    }

    async ensureCleanState(page) {
        console.log('🔄 Ensuring clean state...');
        
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
        
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
        
        const isOnClaimsPage = await page.$('#claimLookupIpt10') !== null;
        
        if (!isOnClaimsPage) {
            console.log('📍 Not on claims page, navigating back...');
            try {
                await page.goto('https://tuxdtzathdedifgtvtapp.ecwcloud.com/mobiledoc/jsp/webemr/webpm/ClaimLookup.jsp', { 
                    waitUntil: 'networkidle',
                    timeout: 10000 
                });
                console.log('✅ Navigated back to claims page');
            } catch (error) {
                console.log('⚠️ Could not navigate, trying to refresh...');
                await page.reload({ waitUntil: 'networkidle' });
            }
        }
        
        await page.fill('#claimLookupIpt10', '');
        console.log('✅ Clean state ensured');
    }

    // ✅ MOVE FILES FROM TEMP TO PROPER LOCAL STRUCTURE with DOS folder
    async organizeLocalFiles(claimNumber, tempFolder, dos) {
        try {
            const files = fs.readdirSync(tempFolder);
            
            for (const file of files) {
                const sourcePath = path.join(tempFolder, file);
                
                // Determine file type and rowId from filename
                let fileType = '';
                let rowId = null;
                
                if (file.startsWith('HCFA_')) {
                    fileType = 'HCFA';
                } 
                else if (file.startsWith('ProgressNote_')) {
                    fileType = 'PROGRESS_NOTE';
                }
                else if (file.startsWith('ERA_')) {
                    fileType = 'ERA';
                    const rowMatch = file.match(/_row(\d+)/);
                    if (rowMatch) {
                        rowId = rowMatch[1];
                    }
                }
                
                if (fileType) {
                    await saveFileLocallyWithStructure(claimNumber, fileType, sourcePath, rowId, dos);
                } else {
                    console.warn(`⚠️ Unknown file type for: ${file}`);
                }
            }
            
            // ✅ Clean up temp folder after organizing
            fs.rmSync(tempFolder, { recursive: true, force: true });
            console.log(`🗑️ Cleaned up temp folder: ${tempFolder}`);
            
        } catch (error) {
            console.error(`❌ Error organizing files for claim ${claimNumber}:`, error.message);
        }
    }

    // ✅ UPLOAD ORGANIZED FILES TO SFTP with DOS folder
    async uploadToSFTPFromLocal(claimNumber, dos) {
        try {
            const baseDir = path.join(this.downloadsDir);
            const dosFolder = formatDOS(dos);
            
            console.log(`📤 Starting SFTP upload for claim ${claimNumber}, DOS: ${dosFolder}...`);
            
            // Upload HCFA files
            const hcfaDir = path.join(baseDir, 'HCFA', claimNumber, dosFolder);
            if (fs.existsSync(hcfaDir)) {
                const hcfaFiles = fs.readdirSync(hcfaDir);
                console.log(`📤 Found ${hcfaFiles.length} HCFA files to upload`);
                for (const file of hcfaFiles) {
                    const localPath = path.join(hcfaDir, file);
                    await uploadFileToSFTPWithStructure(claimNumber, 'HCFA', localPath, null, dos);
                }
            }
            
            // Upload Progress Note files
            const progressNoteDir = path.join(baseDir, 'Medical Records', claimNumber, dosFolder);
            if (fs.existsSync(progressNoteDir)) {
                const progressNoteFiles = fs.readdirSync(progressNoteDir);
                console.log(`📤 Found ${progressNoteFiles.length} Progress Note files to upload`);
                for (const file of progressNoteFiles) {
                    const localPath = path.join(progressNoteDir, file);
                    await uploadFileToSFTPWithStructure(claimNumber, 'PROGRESS_NOTE', localPath, null, dos);
                }
            }
            
            // Upload EOB files
            const eobDir = path.join(baseDir, 'EOB', claimNumber, dosFolder);
            if (fs.existsSync(eobDir)) {
                const eobFiles = fs.readdirSync(eobDir);
                console.log(`📤 Found ${eobFiles.length} EOB files to upload`);
                for (const file of eobFiles) {
                    const localPath = path.join(eobDir, file);
                    // Extract rowId from filename for logging
                    let rowId = null;
                    const rowMatch = file.match(/_row(\d+)/);
                    if (rowMatch) {
                        rowId = rowMatch[1];
                    }
                    await uploadFileToSFTPWithStructure(claimNumber, 'ERA', localPath, rowId, dos);
                }
            }
            
            console.log(`✅ All files uploaded to SFTP for claim ${claimNumber}, DOS: ${dosFolder}`);
            
        } catch (error) {
            console.error(`❌ Error uploading to SFTP for claim ${claimNumber}:`, error.message);
        }
    }

    // ✅ Main automation runner with auto-retry
    async processAllRecords() {
        await this.connectToDatabase();
        
        // ✅ FIRST RUN: Get records with NeedToCheck: "Yes"
        const allRecords = await this.getRecordsToProcess();
        
        console.log(`📊 Total records to process: ${allRecords.length}`);
        this.emailReporter.setTotalRecords(allRecords.length);
        
        if (allRecords.length === 0) {
            console.log("❌ No records found to process");
            await this.mongoClient.close();
            return;
        }

        // Connect to existing browser
        const browser = await chromium.connectOverCDP('http://localhost:9223');
        const context = browser.contexts()[0];
        const page = context.pages().length ? context.pages()[0] : await context.newPage();

        let retrySummary = '';

        try {
            // First Run - process all records with NeedToCheck: "Yes"
            await this.processRecordBatch(allRecords, page, context, false);
            
            // ✅ AUTO-RETRY: Get failed records
            const failedRecords = await this.getFailedRecords();
            
            if (failedRecords.length > 0) {
                console.log(`🔄 Starting AUTO-RETRY for ${failedRecords.length} failed records...`);
                const retryResults = await this.processRecordBatch(failedRecords, page, context, true);
                
                const successCount = retryResults.filter(result => 
                    result === 'Done' || result.includes('Partially completed')
                ).length;
                
                retrySummary = `Auto-retried ${failedRecords.length} failed records, ${successCount} succeeded`;
            } else {
                retrySummary = 'No failed records to retry';
            }
            
        } catch (error) {
            console.error('❌ Automation failed:', error);
        } finally {
            await this.mongoClient.close();
            
            // ✅ Generate final report and send email
            const excelPath = this.emailReporter.generateExcel();
            await this.emailReporter.sendCompletionEmail(excelPath, retrySummary);
            
            console.log('🏁 All records processed - browser remains open');
        }
    }

    // ✅ Process batch of records
    async processRecordBatch(records, page, context, isRetry = false) {
        console.log(`\n👷 Processing ${records.length} records ${isRetry ? '(RETRY)' : ''}`);
        
        const results = [];

        for (const record of records) {
            const result = await this.processSingleRecord(record, page, context, isRetry);
            results.push(result);
        }

        console.log(`🎉 Batch completed ${isRetry ? '(RETRY)' : ''}`);
        return results;
    }

    async processSingleRecord(record, page, context, isRetry = false) {
        const account = record["Account Number"] || record.Account;
        const patientName = record.PATIENT || record.PatientName || 'Unknown';
        const claimNumber = String(record["CLAIMS#"] || record.ClaimNumber || '');
        const charges = record.CHARGES || '';
        const balance = record.Balance || '';
        const dos = record["SERVICE DATE"] || record["Service Date"] || null;
        
        console.log(`\n🚀 Processing Record: ${claimNumber} for ${patientName} (Account: ${account}) DOS: ${dos} ${isRetry ? '(RETRY)' : ''}`);

        // ✅ Create TEMP folder for initial downloads
        const tempFolder = this.ensureTempFolder(claimNumber);
        console.log(`📁 Created temp folder: ${tempFolder}`);

        let hcfaSuccess = false;
        let progressNoteSuccess = false;
        let eraSuccess = false;
        let finalStatus = "Failed";

        const startTime = new Date();
        
        if (!isRetry) {
            this.emailReporter.addRecord(claimNumber, patientName, 'Started', startTime);
        }

        try {
            // ✅ CHECK FOR LICENSE EXPIRED POPUP BEFORE ANY OPERATION
            const licensePopupFound = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupFound) {
                console.log(`⏭️ Skipping claim ${claimNumber} due to license expired popup`);
                finalStatus = "Failed - License Expired";
                
                // Clean up temp folder
                if (fs.existsSync(tempFolder)) {
                    fs.rmSync(tempFolder, { recursive: true, force: true });
                }
                
                await this.updateRecordStatus(record._id, finalStatus, isRetry);
                this.emailReporter.updateRecordStatus(claimNumber, finalStatus);
                return finalStatus;
            }

            // Ensure we start from a clean state
            await this.ensureCleanState(page);

            // ✅ CHECK FOR LICENSE EXPIRED POPUP AFTER CLEAN STATE
            const licensePopupAfterClean = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupAfterClean) {
                console.log(`⏭️ Skipping claim ${claimNumber} due to license expired popup (after clean state)`);
                finalStatus = "Failed - License Expired";
                
                // Clean up temp folder
                if (fs.existsSync(tempFolder)) {
                    fs.rmSync(tempFolder, { recursive: true, force: true });
                }
                
                await this.updateRecordStatus(record._id, finalStatus, isRetry);
                this.emailReporter.updateRecordStatus(claimNumber, finalStatus);
                return finalStatus;
            }

            // 1️⃣ Search for the claim
            await page.fill('#claimLookupIpt10', claimNumber);
            await page.click('#btnclaimlookup');

            // Wait for the claim modal to open
            try {
                await page.waitForSelector('.modal.fade.bluetheme.billing-width.in', { state: 'visible', timeout: 20000 });
            } catch (error) {
                // Check if license popup appeared instead
                const licensePopupDuringSearch = await this.checkForLicenseExpiredPopup(page, claimNumber);
                if (licensePopupDuringSearch) {
                    console.log(`⏭️ Skipping claim ${claimNumber} due to license expired popup (during search)`);
                    finalStatus = "Failed - License Expired";
                    
                    // Clean up temp folder
                    if (fs.existsSync(tempFolder)) {
                        fs.rmSync(tempFolder, { recursive: true, force: true });
                    }
                    
                    await this.updateRecordStatus(record._id, finalStatus, isRetry);
                    this.emailReporter.updateRecordStatus(claimNumber, finalStatus);
                    return finalStatus;
                }
                throw error; // Re-throw if it's a different error
            }

            // ✅ CHECK FOR LICENSE EXPIRED POPUP BEFORE HCFA
            const licensePopupBeforeHCFA = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupBeforeHCFA) {
                console.log(`⏭️ Skipping claim ${claimNumber} due to license expired popup (before HCFA)`);
                finalStatus = "Failed - License Expired";
                
                // Clean up temp folder
                if (fs.existsSync(tempFolder)) {
                    fs.rmSync(tempFolder, { recursive: true, force: true });
                }
                
                await this.updateRecordStatus(record._id, finalStatus, isRetry);
                this.emailReporter.updateRecordStatus(claimNumber, finalStatus);
                return finalStatus;
            }

            // 2️⃣ Download HCFA
            hcfaSuccess = await this.downloadHCFA(page, claimNumber, charges, balance, tempFolder);

            // ✅ CHECK FOR LICENSE EXPIRED POPUP AFTER HCFA
            const licensePopupAfterHCFA = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupAfterHCFA) {
                console.log(`⏭️ Skipping further processing for claim ${claimNumber} due to license expired popup`);
                finalStatus = hcfaSuccess ? "Partially completed - License expired after HCFA" : "Failed - License Expired";
                
                // Clean up temp folder if no files were downloaded
                if (!hcfaSuccess && fs.existsSync(tempFolder)) {
                    fs.rmSync(tempFolder, { recursive: true, force: true });
                }
                
                // Organize and upload any files that were downloaded
                if (hcfaSuccess) {
                    await this.organizeLocalFiles(claimNumber, tempFolder, dos);
                    await this.uploadToSFTPFromLocal(claimNumber, dos);
                }
                
                await this.updateRecordStatus(record._id, finalStatus, isRetry);
                this.emailReporter.updateRecordStatus(claimNumber, finalStatus);
                return finalStatus;
            }

            // 3️⃣ Download Progress Note
            progressNoteSuccess = await this.downloadProgressNote(page, claimNumber, patientName, charges, balance, context, tempFolder);

            // ✅ CHECK FOR LICENSE EXPIRED POPUP AFTER PROGRESS NOTE
            const licensePopupAfterProgressNote = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupAfterProgressNote) {
                console.log(`⏭️ Skipping ERA processing for claim ${claimNumber} due to license expired popup`);
                
                // Determine status based on what was successful
                if (hcfaSuccess && progressNoteSuccess) {
                    finalStatus = "Partially completed - License expired after Progress Note";
                } else if (hcfaSuccess && !progressNoteSuccess) {
                    finalStatus = "Partially completed - License expired, Progress Note failed";
                } else if (!hcfaSuccess && progressNoteSuccess) {
                    finalStatus = "Partially completed - License expired, HCFA failed";
                } else {
                    finalStatus = "Failed - License Expired";
                }
                
                // Clean up temp folder if no files were downloaded
                if (!hcfaSuccess && !progressNoteSuccess && fs.existsSync(tempFolder)) {
                    fs.rmSync(tempFolder, { recursive: true, force: true });
                }
                
                // Organize and upload any files that were downloaded
                if (hcfaSuccess || progressNoteSuccess) {
                    await this.organizeLocalFiles(claimNumber, tempFolder, dos);
                    await this.uploadToSFTPFromLocal(claimNumber, dos);
                }
                
                await this.updateRecordStatus(record._id, finalStatus, isRetry);
                this.emailReporter.updateRecordStatus(claimNumber, finalStatus);
                return finalStatus;
            }

            // 4️⃣ Process ERA payments
            const eraResult = await this.processERAPayments(page, claimNumber, patientName, charges, balance, context, tempFolder);
            eraSuccess = eraResult.filesFetched > 0;

            // ✅ CHECK FOR LICENSE EXPIRED POPUP AFTER ERA
            const licensePopupAfterERA = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupAfterERA) {
                console.log(`ℹ️ License expired popup appeared after ERA processing for claim ${claimNumber}`);
                // Continue with normal processing since we already got ERA files
            }

            // ✅ COMPLETE STATUS DETERMINATION
            const successCount = [hcfaSuccess, progressNoteSuccess, eraSuccess].filter(Boolean).length;
            
            if (successCount === 3) {
                finalStatus = "Done";
            } else if (successCount === 0) {
                finalStatus = "Failed";
            } else {
                if (!hcfaSuccess && !progressNoteSuccess && eraSuccess) {
                    finalStatus = "Partially completed - HCFA & Progress Note pending";
                } else if (!hcfaSuccess && !eraSuccess && progressNoteSuccess) {
                    finalStatus = "Partially completed - HCFA & ERA pending";
                } else if (!progressNoteSuccess && !eraSuccess && hcfaSuccess) {
                    finalStatus = "Partially completed - Progress Note & ERA pending";
                } else if (!hcfaSuccess && progressNoteSuccess && eraSuccess) {
                    finalStatus = "Partially completed - HCFA pending";
                } else if (hcfaSuccess && !progressNoteSuccess && eraSuccess) {
                    finalStatus = "Partially completed - Progress Note pending";
                } else if (hcfaSuccess && progressNoteSuccess && !eraSuccess) {
                    finalStatus = "Partially completed - ERA pending";
                }
            }

            console.log(`📊 Files fetched: ${successCount}/3 - Status: ${finalStatus}`);

            // ✅ ORGANIZE FILES INTO LOCAL STRUCTURE with DOS folder
            if (successCount > 0) {
                await this.organizeLocalFiles(claimNumber, tempFolder, dos);
                
                // ✅ UPLOAD TO SFTP (ENABLED) with DOS folder
                await this.uploadToSFTPFromLocal(claimNumber, dos);
            } else {
                // Clean up temp folder if no files were downloaded
                if (fs.existsSync(tempFolder)) {
                    fs.rmSync(tempFolder, { recursive: true, force: true });
                }
            }

            // ✅ Update record status
            await this.updateRecordStatus(record._id, finalStatus, isRetry);

            // ✅ Update email reporter
            this.emailReporter.updateRecordStatus(claimNumber, finalStatus);

            console.log(`✅ Successfully processed claim ${claimNumber}`);

            return finalStatus;

        } catch (error) {
            console.error(`❌ Failed to process claim ${claimNumber}:`, error.message);
            finalStatus = "Failed";
            
            // Clean up temp folder if it exists
            if (fs.existsSync(tempFolder)) {
                fs.rmSync(tempFolder, { recursive: true, force: true });
            }
            
            await this.updateRecordStatus(record._id, finalStatus, isRetry);
            this.emailReporter.updateRecordStatus(claimNumber, finalStatus);
            return finalStatus;
        } finally {
            // ALWAYS ensure clean state before moving to next claim
            console.log('🔄 Cleaning up before next claim...');
            await this.ensureCleanState(page);
        }
    }

    async downloadHCFA(page, claimNumber, charges, balance, tempFolder) {
        console.log(`📋 Downloading HCFA for claim ${claimNumber}...`);
        
        try {
            await page.waitForSelector('[id^="printHCFADropDown"]', { state: 'visible' });
            await page.click('[id^="printHCFADropDown"]');
            
            // ✅ CHECK FOR LICENSE POPUP BEFORE CLICKING HCFA
            const licensePopupBeforeClick = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupBeforeClick) {
                return false;
            }
            
            await page.evaluate(() => document.querySelector('#billingClaimLink17').click());

            try {
                const modal = await page.waitForSelector('.modal.claimforms-mod.in', { state: 'visible', timeout: 20000 });
                
                // ✅ CHECK FOR LICENSE POPUP AFTER MODAL APPEARS
                const licensePopupAfterModal = await this.checkForLicenseExpiredPopup(page, claimNumber);
                if (licensePopupAfterModal) {
                    await page.keyboard.press('Escape');
                    return false;
                }
                
                const iframeHandle = await modal.$('#claimFormViewerFrame');

                let iframeSrc = await iframeHandle.getAttribute('src');
                const baseUrl = new URL(page.url()).origin;
                if (!iframeSrc.startsWith('http')) iframeSrc = baseUrl + iframeSrc;

                console.log(`🌐 Fetching HCFA from: ${iframeSrc}`);

                const pdfResponse = await page.request.get(iframeSrc, {
                    headers: {
                        'Referer': page.url(),
                        'User-Agent': await page.evaluate(() => navigator.userAgent),
                    }
                });

                if (!pdfResponse.ok()) {
                    return false;
                }

                const pdfBuffer = await pdfResponse.body();
                
                const uniqueSuffix = this.getUniqueSuffix(charges, balance);
                const savePath = path.join(tempFolder, `HCFA_${claimNumber}-${uniqueSuffix}.pdf`);
                
                fs.writeFileSync(savePath, pdfBuffer);
                console.log(`💾 HCFA PDF saved temporarily at: ${savePath}`);

                await page.keyboard.press('Escape');
                await page.waitForTimeout(2000);
                
                await page.waitForSelector('.modal.fade.bluetheme.billing-width.in', { state: 'visible', timeout: 10000 });

                return true;

            } catch (timeoutError) {
                // Check if license popup appeared
                const licensePopupDuringWait = await this.checkForLicenseExpiredPopup(page, claimNumber);
                if (licensePopupDuringWait) {
                    return false;
                }
                throw timeoutError;
            }

        } catch (error) {
            console.error(`❌ HCFA download failed for claim ${claimNumber}`);
            return false;
        }
    }

    async downloadProgressNote(page, claimNumber, patientName, charges, balance, context, tempFolder) {
        console.log(`📝 Downloading Progress Note for claim ${claimNumber}...`);
        
        try {
            console.log('📝 Clicking Progress Note button...');
            
            // ✅ CHECK FOR LICENSE POPUP BEFORE CLICKING
            const licensePopupBeforeClick = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupBeforeClick) {
                return false;
            }
            
            await page.click('[id^="claimProgressNoteBtn"]');
            
            try {
                const frameHandle = await page.waitForSelector('#ProgNoteViwerFrame', { timeout: 20000 });
                
                // ✅ CHECK FOR LICENSE POPUP AFTER FRAME APPEARS
                const licensePopupAfterFrame = await this.checkForLicenseExpiredPopup(page, claimNumber);
                if (licensePopupAfterFrame) {
                    await page.keyboard.press('Escape');
                    return false;
                }
                
                const frame = await frameHandle.contentFrame();
                if (!frame) return false;

                await frame.waitForFunction(() => {
                    const html = document.body.innerHTML.trim();
                    return html.length > 10;
                }, { timeout: 20000 });

                const iframeHTML = await frame.evaluate(() => document.documentElement.outerHTML);

                const tempPage = await context.newPage();
                await tempPage.setContent(iframeHTML, { waitUntil: 'networkidle' });

                const safePatientName = patientName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
                const uniqueSuffix = this.getUniqueSuffix(charges, balance);
                
                const pdfPath = path.join(tempFolder, `ProgressNote_${claimNumber}-${uniqueSuffix}_${safePatientName}.pdf`);
                
                await tempPage.pdf({ path: pdfPath, format: 'A4', printBackground: true });
                console.log(`💾 Progress Note saved temporarily at: ${pdfPath}`);

                await tempPage.close();

                await page.keyboard.press('Escape');
                await page.waitForTimeout(2000);

                await page.waitForSelector('.modal.fade.bluetheme.billing-width.in', { state: 'visible', timeout: 10000 });

                return true;

            } catch (timeoutError) {
                // Check if license popup appeared
                const licensePopupDuringWait = await this.checkForLicenseExpiredPopup(page, claimNumber);
                if (licensePopupDuringWait) {
                    return false;
                }
                throw timeoutError;
            }

        } catch (error) {
            console.error(`❌ Progress Note download failed for claim ${claimNumber}`);
            return false;
        }
    }

    async processERAPayments(page, claimNumber, patientName, charges, balance, context, tempFolder) {
        console.log(`\n💳 Processing ERA payments for claim ${claimNumber}...`);
        
        let result = {
            filesFetched: 0,
            status: "Unknown"
        };
        
        try {
            console.log('💳 Clicking Insurances & Payment tab...');
            
            // ✅ CHECK FOR LICENSE POPUP BEFORE CLICKING
            const licensePopupBeforeClick = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupBeforeClick) {
                return result;
            }
            
            await page.click('#billingClaimLink4');
            await page.waitForTimeout(3000);

            const tableExists = await page.$('.claimPaymentTbl table tbody') !== null;
            
            if (!tableExists) {
                console.log('📭 No payment records found');
                return result;
            }

            try {
                await page.waitForSelector('.claimPaymentTbl table tbody tr', { timeout: 5000 });
            } catch (error) {
                console.log('⏰ No payment rows found');
                return result;
            }
            
            const paymentRows = await page.$$('.claimPaymentTbl table tbody tr');
            console.log(`📊 Found ${paymentRows.length} payment rows`);
            
            if (paymentRows.length === 0) {
                return result;
            }

            let totalEIcons = 0;
            
            for (const row of paymentRows) {
                const hasEIcon = await row.$('td.w30 .icon-e') !== null;
                if (hasEIcon) totalEIcons++;
            }

            console.log(`🔍 Found ${totalEIcons} rows with E icons`);

            if (totalEIcons === 0) {
                return result;
            }

            let processedRowKeys = new Set();
            let eraDownloadCount = 0;
            
            const baseUrl = new URL(page.url()).origin;
            
            for (let i = 0; i < paymentRows.length; i++) {
                const row = paymentRows[i];
                
                // ✅ CHECK FOR LICENSE POPUP BEFORE PROCESSING EACH ROW
                const licensePopupBeforeRow = await this.checkForLicenseExpiredPopup(page, claimNumber);
                if (licensePopupBeforeRow) {
                    console.log(`⏭️ Stopping ERA processing due to license expired popup`);
                    break;
                }
                
                const hasEIcon = await row.$('td.w30 .icon-e') !== null;
                
                if (hasEIcon) {
                    const rowData = await this.getRowData(row, i);
                    const rowKey = this.createRowKey(rowData);
                    
                    let uniqueIdentifier;
                    let rowId;
                    
                    if (processedRowKeys.has(rowKey)) {
                        const uniqueSuffix = await this.findUniqueSuffix(rowData, processedRowKeys);
                        uniqueIdentifier = `${rowKey}_${uniqueSuffix}`;
                        rowId = `row${i+1}_${uniqueSuffix}`;
                        processedRowKeys.add(uniqueIdentifier);
                    } else {
                        uniqueIdentifier = rowData.paymentId;
                        rowId = `row${i+1}`;
                        processedRowKeys.add(rowKey);
                    }
                    
                    const success = await this.processERARow(row, rowData, uniqueIdentifier, rowId, baseUrl, context, page, claimNumber, patientName, charges, balance, tempFolder);
                    if (success) {
                        eraDownloadCount++;
                    }
                }
            }

            result.filesFetched = eraDownloadCount;
            console.log(`✅ Downloaded: ${eraDownloadCount} ERA files`);

        } catch (error) {
            console.error(`❌ ERA processing failed for claim ${claimNumber}`);
        }

        return result;
    }

    async getRowData(row, rowIndex) {
        const columns = await row.$$('td');
        const rowData = {
            rowIndex: rowIndex + 1,
            paymentId: await this.getColumnText(row, 2),
            date: await this.getColumnText(row, 3),
            payer: await this.getColumnText(row, 4),
            amount: await this.getColumnText(row, 5),
            checkNumber: await this.getColumnText(row, 6),
            status: await this.getColumnText(row, 7),
        };
        
        for (let i = 1; i <= columns.length; i++) {
            const colText = await this.getColumnText(row, i);
            if (colText && colText !== 'Unknown') {
                rowData[`col${i}`] = colText;
            }
        }
        
        return rowData;
    }

    async getColumnText(row, columnIndex) {
        try {
            const element = await row.$(`td:nth-child(${columnIndex})`);
            if (element) {
                const text = await element.textContent();
                return text ? text.trim() : 'Unknown';
            }
        } catch (error) {
            // Column might not exist
        }
        return 'Unknown';
    }

    createRowKey(rowData) {
        const keys = [
            `${rowData.paymentId}_${rowData.date}_${rowData.payer}`,
            `${rowData.paymentId}_${rowData.date}_${rowData.amount}`,
            `${rowData.paymentId}_${rowData.checkNumber}`,
            `${rowData.paymentId}_${rowData.payer}_${rowData.amount}`
        ];
        
        for (const key of keys) {
            if (!key.includes('Unknown_Unknown') && !key.endsWith('_Unknown')) {
                return key;
            }
        }
        
        return `row_${rowData.rowIndex}`;
    }

    async findUniqueSuffix(rowData, processedKeys) {
        const possibleSuffixes = [
            rowData.checkNumber,
            rowData.amount,
            rowData.status,
            `row${rowData.rowIndex}`
        ];
        
        for (const suffix of possibleSuffixes) {
            if (suffix && suffix !== 'Unknown') {
                const testKey = `${this.createRowKey(rowData)}_${suffix}`;
                if (!processedKeys.has(testKey)) {
                    return suffix;
                }
            }
        }
        
        return `ts${Date.now()}`;
    }

    async processERARow(row, rowData, uniqueIdentifier, rowId, baseUrl, context, page, claimNumber, patientName, charges, balance, tempFolder) {
        console.log(`\n🖱️ Processing ERA for: ${rowData.payer} (Row ID: ${rowId})`);
        
        try {
            // ✅ CHECK FOR LICENSE POPUP BEFORE DOUBLE CLICK
            const licensePopupBeforeClick = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupBeforeClick) {
                return false;
            }
            
            const eIcon = await row.$('td.w30 .icon-e');
            await eIcon.dblclick();
            
            console.log('⏳ Waiting for ERA popup to open...');
            await page.waitForTimeout(5000);
            
            try {
                await page.waitForSelector('.modal.in, .modal.fade.in', { timeout: 5000 });
            } catch (error) {
                return false;
            }
            
            // ✅ CHECK FOR LICENSE POPUP AFTER ERA POPUP
            const licensePopupAfterERA = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupAfterERA) {
                await page.keyboard.press('Escape');
                return false;
            }
            
            const allIframes = await page.$$('iframe');
            
            let eraIframe = null;
            let eraIframeSrc = null;
            
            for (const iframe of allIframes) {
                const src = await iframe.getAttribute('src');
                if (src && src.includes('ViewEraFile_Encode.jsp')) {
                    eraIframe = iframe;
                    eraIframeSrc = src;
                    break;
                }
            }
            
            if (eraIframe && eraIframeSrc) {
                if (!eraIframeSrc.startsWith('http')) {
                    eraIframeSrc = baseUrl + eraIframeSrc;
                }
                
                const eraFrame = await eraIframe.contentFrame();
                if (eraFrame) {
                    await eraFrame.waitForLoadState('networkidle');
                    const eraHTML = await eraFrame.evaluate(() => document.documentElement.outerHTML);
                    
                    const uniqueSuffix = this.getUniqueSuffix(charges, balance);
                    const safePayer = rowData.payer.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
                    const safePatient = patientName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
                    
                    if (eraHTML.includes('<html') || eraHTML.includes('<!DOCTYPE')) {
                        const eraPage = await context.newPage();
                        await eraPage.setContent(eraHTML, { waitUntil: 'networkidle' });
                        
                        // Include rowId in filename
                        const eraPath = path.join(tempFolder, `ERA_${claimNumber}-${uniqueSuffix}_${safePatient}_${safePayer}_${rowId}.pdf`);
                        
                        await eraPage.pdf({ 
                            path: eraPath, 
                            format: 'A4', 
                            printBackground: true,
                            margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
                        });
                        
                        await eraPage.close();
                    } else {
                        const eraPath = path.join(tempFolder, `ERA_${claimNumber}-${uniqueSuffix}_${safePatient}_${safePayer}_${rowId}.html`);
                        fs.writeFileSync(eraPath, eraHTML);
                    }
                } else {
                    return false;
                }
            } else {
                return false;
            }
            
            await page.keyboard.press('Escape');
            await page.waitForTimeout(2000);
            
            await page.waitForTimeout(1000);
            
            return true;
            
        } catch (error) {
            console.log(`❌ ERA processing failed`);
            return false;
        }
    }

    getUniqueSuffix(charges, balance) {
        const cleanCharges = (charges || '').replace(/[^0-9.]/g, '').replace('.', '') || '0';
        const cleanBalance = (balance || '').replace(/[^0-9.]/g, '').replace('.', '') || '0';
        return `${cleanCharges}-${cleanBalance}`;
    }

    async run() {
        console.log('🚀 Starting ECW Medical Records Automation with Email Reporting...');
        await this.processAllRecords();
    }
}

// Run the automation
if (require.main === module) {
    const automation = new ECWAutomation();
    automation.run().catch(console.error);
}

module.exports = ECWAutomation;