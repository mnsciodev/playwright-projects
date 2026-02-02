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

// ✅ Get today's date in M-D-YY format (e.g., 1-2-26 for Jan 2, 2026)
function getRunDate() {
    const today = new Date();
    const month = today.getMonth() + 1;  // 1-12
    const day = today.getDate();         // 1-31
    const year = today.getFullYear().toString().slice(-2); // 26
    return `${month}-${day}-${year}`;
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
        
        const date = moment(dos).utc();
        if (date.isValid()) {
            return date.format('MMDDYYYY');
        }
        
        if (typeof dos === 'string') {
            const parts = dos.split('/');
            if (parts.length === 3) {
                const month = parts[0].padStart(2, '0');
                const day = parts[1].padStart(2, '0');
                const year = parts[2];
                return `${month}${day}${year}`;
            }
        }
        
        return '00000000';
    } catch (error) {
        console.error(`❌ Error formatting DOS: ${dos}`, error.message);
        return '00000000';
    }
}

async function saveFileLocallyWithStructure(claimNumber, fileType, sourcePath, patientName = null, rowId = null, dos = null, account = null) {
    try {
        const dosFolder = formatDOS(dos);
        let localDir;
        
        if (fileType === 'HCFA') {
            localDir = path.join(__dirname, 'ecw_downloads', 'HCFA', claimNumber, dosFolder);
        } 
        else if (fileType === 'PROGRESS_NOTE') {
            localDir = path.join(__dirname, 'ecw_downloads', 'Medical Records', claimNumber, dosFolder);
        }
        else if (fileType === 'ERA') {
            localDir = path.join(__dirname, 'ecw_downloads', 'Denied EOBs', claimNumber, dosFolder);
        }
        else {
            console.error(`❌ Unknown file type: ${fileType}`);
            return null;
        }
        
        if (!fs.existsSync(localDir)) {
            fs.mkdirSync(localDir, { recursive: true });
            console.log(`📁 Created local directory: ${localDir}`);
        }
        
        const originalFileName = path.basename(sourcePath);
        let fileName;
        
        if (fileType === 'HCFA') {
            const runDate = getRunDate();
            fileName = `HCFA_${claimNumber}-${runDate}.pdf`;
        } 
        else if (fileType === 'PROGRESS_NOTE') {
            // ✅ FIX: Check if this is a Hub Flow file with suffix
            if (originalFileName.startsWith(`ProgressNote_${claimNumber}-${account}_`)) {
                // This is already a Hub Flow file with suffix (e.g., ProgressNote_40899-172838_1_filename.pdf)
                // Keep the original name
                fileName = originalFileName;
                console.log(`🔄 Keeping Hub Flow file name: ${fileName}`);
            } else if (originalFileName.startsWith('ProgressNote_')) {
                // Standard ProgressNote file
                fileName = originalFileName;
            } else {
                // Convert to standard ProgressNote format
                fileName = `ProgressNote_${claimNumber}-${account}.pdf`;
                console.log(`🔄 Converting: ${originalFileName} → ${fileName}`);
            }
        }
        else if (fileType === 'ERA') {
            // Keep original ERA filename (contains payer info)
            fileName = originalFileName;
        }
        else {
            fileName = originalFileName;
        }
        
        const destinationPath = path.join(localDir, fileName);
        
        // ✅ Check if file already exists
        if (fs.existsSync(destinationPath)) {
            // For Progress Notes with suffixes, don't overwrite - add timestamp
            if (fileType === 'PROGRESS_NOTE' && fileName.includes('_') && !fileName.endsWith(`-${account}.pdf`)) {
                const timestamp = Date.now().toString().slice(-6);
                const newFileName = fileName.replace('.pdf', `_${timestamp}.pdf`);
                const newPath = path.join(localDir, newFileName);
                fs.copyFileSync(sourcePath, newPath);
                console.log(`💾 Saved as: ${newFileName} (avoided overwrite)`);
                return newPath;
            } else {
                // Overwrite HCFA and standard ProgressNote files
                fs.unlinkSync(destinationPath);
                console.log(`🗑️ Overwriting existing: ${fileName}`);
            }
        }
        
        fs.copyFileSync(sourcePath, destinationPath);
        console.log(`💾 Saved locally: ${destinationPath}`);
        
        return destinationPath;
        
    } catch (error) {
        console.error(`❌ Error saving file locally for claim ${claimNumber}:`, error.message);
        return null;
    }
}
// ✅ Upload single file to SFTP with new structure including DOS folder
async function uploadFileToSFTPWithStructure(claimNumber, fileType, localPath, patientName = null, rowId = null, dos = null) {
    try {
        const dosFolder = formatDOS(dos);
        const fileName = path.basename(localPath);
        let remotePath;
        
        if (fileType === 'HCFA') {
            remotePath = `ClaimDocuments/Arcadia Medical Associates PA/HCFA/${claimNumber}/${dosFolder}/${fileName}`;
        } 
        else if (fileType === 'PROGRESS_NOTE') {
            remotePath = `ClaimDocuments/Arcadia Medical Associates PA/Medical Records/${claimNumber}/${dosFolder}/${fileName}`;
        }
        else if (fileType === 'ERA') {
            remotePath = `ClaimDocuments/Arcadia Medical Associates PA/Denied EOBs/${claimNumber}/${dosFolder}/${fileName}`;
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

    ensureTempFolder(claimNumber) {
        const tempFolder = path.join(this.downloadsDir, 'temp', claimNumber);
        if (!fs.existsSync(tempFolder)) {
            fs.mkdirSync(tempFolder, { recursive: true });
        }
        return tempFolder;
    }

    // ✅ NEW: Clean up ALL old files for a claim before processing
    async cleanupOldFilesForClaim(claimNumber, dos) {
        try {
            const dosFolder = formatDOS(dos);
            const baseDir = path.join(this.downloadsDir);
            
            console.log(`🧼 Cleaning ALL old files for claim ${claimNumber}...`);
            
            const foldersToClean = [
                path.join(baseDir, 'HCFA', claimNumber, dosFolder),
                path.join(baseDir, 'Medical Records', claimNumber, dosFolder),
                path.join(baseDir, 'Denied EOBs', claimNumber, dosFolder),
                path.join(this.downloadsDir, 'temp', claimNumber)
            ];
            
            for (const folderPath of foldersToClean) {
                if (fs.existsSync(folderPath)) {
                    fs.rmSync(folderPath, { recursive: true, force: true });
                    console.log(`🗑️ Removed: ${folderPath}`);
                }
            }
            
        } catch (error) {
            console.error(`❌ Error cleaning up for claim ${claimNumber}:`, error.message);
        }
    }

    async connectToDatabase() {
        this.mongoClient = new MongoClient(MongoURL);
        await this.mongoClient.connect();
        this.db = this.mongoClient.db();
        console.log('✅ Connected to MongoDB');
    }

    async getRecordsToProcess() {
        const records = await this.db.collection("aiclaimmasters").find({
            NeedToCheck: "Yes",
            PracticeId: new ObjectId("680ca90e6b528266603753b8")
        }).sort({ "DateOfService": -1 }).toArray();
        
        console.log(`📊 Found ${records.length} records to process for Practice ID: 680ca90e6b528266603753b8`);
        return records;
    }

    async getFailedRecords() {
        const failedRecords = await this.db.collection("aiclaimmasters").find({
            NeedToCheck: "No",
            Status: "Failed",
            PracticeId: new ObjectId("680ca90e6b528266603753b8")
        }).sort({ "DateOfService": -1 }).toArray();
        
        console.log(`🔄 Found ${failedRecords.length} failed records to retry for Practice ID: 680ca90e6b528266603753b8`);
        return failedRecords;
    }

    async updateRecordStatus(recordId, status, isRetry = false) {
        try {
            const collection = this.db.collection("aiclaimmasters");
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
            const licensePopupSelector = '.modal-content:has-text("Claim\'s rendering Provider\'s license is expired")';
            
            const popupExists = await page.$(licensePopupSelector);
            if (popupExists && await popupExists.isVisible()) {
                console.log(`⚠️ LICENSE EXPIRED POPUP DETECTED for claim ${claimNumber}`);
                
                const errorLogsDir = path.join(__dirname, 'error_logs');
                if (!fs.existsSync(errorLogsDir)) {
                    fs.mkdirSync(errorLogsDir, { recursive: true });
                }
                const screenshotPath = path.join(errorLogsDir, `license_expired_${claimNumber}_${Date.now()}.png`);
                await page.screenshot({ path: screenshotPath });
                console.log(`📸 Screenshot saved: ${screenshotPath}`);
                
                const okButton = await page.$('button:has-text("OK")');
                if (okButton) {
                    await okButton.click();
                    console.log(`✅ Clicked OK on license expired popup`);
                    await page.waitForTimeout(1000);
                } else {
                    const anyButton = await page.$('.modal-footer button');
                    if (anyButton) {
                        await anyButton.click();
                        console.log(`✅ Clicked available button on popup`);
                        await page.waitForTimeout(1000);
                    }
                }
                
                return true;
            }
            
            return false;
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


    

  async organizeLocalFiles(claimNumber, patientName, tempFolder, dos, account) {
    try {
        const files = fs.readdirSync(tempFolder);
        const dosFolder = formatDOS(dos);
        const baseDir = path.join(this.downloadsDir);
        
        console.log(`📦 Processing ${files.length} new files from temp folder...`);
        
        let movedCount = 0;
        for (const file of files) {
            const sourcePath = path.join(tempFolder, file);
            
            let fileType = '';
            let rowId = null;
            
            if (file.startsWith('HCFA_')) {
                fileType = 'HCFA';
            } 
            else if (file.startsWith('ProgressNote_') || file.startsWith('Temp_')) {
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
                // ✅ CONVERT ANY REMAINING TIFF FILES TO PDF
                // Skip TIFF files entirely
if (fileType === 'PROGRESS_NOTE' && (file.endsWith('.tiff') || file.endsWith('.tif'))) {
    console.log(`   ⚠️ Skipping TIFF file: ${file}`);
    fs.unlinkSync(sourcePath); // Delete the TIFF file
    continue;
}
                
                // ✅ For PDF files and other formats, just save normally
                const destination = await saveFileLocallyWithStructure(claimNumber, fileType, sourcePath, patientName, rowId, dos, account);
                if (destination) {
                    movedCount++;
                    console.log(`✅ Moved: ${path.basename(destination)}`);
                    
                    // Delete the source file after successful move
                    fs.unlinkSync(sourcePath);
                }
            } else {
                console.warn(`⚠️ Unknown file type for: ${file}`);
            }
        }
        
        console.log(`📊 Successfully processed ${movedCount} files`);
        
        // Clean up temp folder
        if (fs.existsSync(tempFolder)) {
            fs.rmSync(tempFolder, { recursive: true, force: true });
            console.log(`🗑️ Cleaned up temp folder: ${tempFolder}`);
        }
        
    } catch (error) {
        console.error(`❌ Error organizing files for claim ${claimNumber}:`, error.message);
    }
}
    async uploadToSFTPFromLocal(claimNumber, patientName, dos) {
        try {
            const baseDir = path.join(this.downloadsDir);
            const dosFolder = formatDOS(dos);
            
            console.log(`📤 Starting SFTP upload for claim ${claimNumber}, DOS: ${dosFolder}...`);
            
            let totalUploaded = 0;
            
            // ✅ HCFA files
            const hcfaDir = path.join(baseDir, 'HCFA', claimNumber, dosFolder);
            if (fs.existsSync(hcfaDir)) {
                const hcfaFiles = fs.readdirSync(hcfaDir);
                console.log(`📤 Found ${hcfaFiles.length} HCFA files to upload`);
                for (const file of hcfaFiles) {
                    const localPath = path.join(hcfaDir, file);
                    const success = await uploadFileToSFTPWithStructure(claimNumber, 'HCFA', localPath, patientName, null, dos);
                    if (success) totalUploaded++;
                }
            }
            
            // ✅ Progress Note files
            const progressNoteDir = path.join(baseDir, 'Medical Records', claimNumber, dosFolder);
            if (fs.existsSync(progressNoteDir)) {
                const progressNoteFiles = fs.readdirSync(progressNoteDir);
                console.log(`📤 Found ${progressNoteFiles.length} Progress Note files to upload`);
                for (const file of progressNoteFiles) {
                    const localPath = path.join(progressNoteDir, file);
                    const success = await uploadFileToSFTPWithStructure(claimNumber, 'PROGRESS_NOTE', localPath, patientName, null, dos);
                    if (success) totalUploaded++;
                }
            }
            
            // ✅ EOB files
            const eobDir = path.join(baseDir, 'Denied EOBs', claimNumber, dosFolder);
            if (fs.existsSync(eobDir)) {
                const eobFiles = fs.readdirSync(eobDir);
                console.log(`📤 Found ${eobFiles.length} EOB files to upload`);
                for (const file of eobFiles) {
                    const localPath = path.join(eobDir, file);
                    let rowId = null;
                    const rowMatch = file.match(/_row(\d+)/);
                    if (rowMatch) {
                        rowId = rowMatch[1];
                    }
                    const success = await uploadFileToSFTPWithStructure(claimNumber, 'ERA', localPath, patientName, rowId, dos);
                    if (success) totalUploaded++;
                }
            }
            
            console.log(`✅ Uploaded ${totalUploaded} total files to SFTP for claim ${claimNumber}`);
            
        } catch (error) {
            console.error(`❌ Error uploading to SFTP for claim ${claimNumber}:`, error.message);
        }
    }

    // ✅ Main automation runner with auto-retry
    async processAllRecords() {
        await this.connectToDatabase();
        
        const allRecords = await this.getRecordsToProcess();
        
        console.log(`📊 Total records to process: ${allRecords.length}`);
        this.emailReporter.setTotalRecords(allRecords.length);
        
        if (allRecords.length === 0) {
            console.log("❌ No records found to process");
            await this.mongoClient.close();
            return;
        }

        const browser = await chromium.connectOverCDP('http://localhost:9223');
        const context = browser.contexts()[0];
        const page = context.pages().length ? context.pages()[0] : await context.newPage();

        let retrySummary = '';

        try {
            await this.processRecordBatch(allRecords, page, context, false);
            
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
            
            const excelPath = this.emailReporter.generateExcel();
            await this.emailReporter.sendCompletionEmail(excelPath, retrySummary);
            
            console.log('🏁 All records processed - browser remains open');
        }
    }

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
        const account = record["Account"] || 'Unknown';
        const patientName = record["PatientLastName"] || 'Unknown';
        const claimNumber = String(record["Bill"] || '');
        const dos = record["DateOfService"] || null;
        
        // ✅ FIX: Format the DOS WITHOUT timezone conversion - use UTC mode
        // Use moment.utc() to prevent timezone conversion
        const displayDOS = dos ? moment.utc(dos).format('MM/DD/YYYY') : 'N/A';
        
        console.log(`\n🚀 Processing Record: ${claimNumber} for ${patientName} (Account: ${account}) Practice: 680ca90e6b528266603753b8 DOS value: ${displayDOS} ${isRetry ? '(RETRY)' : ''}`);
        
        // ✅ FIRST: Clean up ALL old files for this claim
        await this.cleanupOldFilesForClaim(claimNumber, dos);
        
        const tempFolder = this.ensureTempFolder(claimNumber);
        console.log(`📁 Created fresh temp folder: ${tempFolder}`);

        let hcfaSuccess = false;
        let progressNoteSuccess = false;
        let eraSuccess = false;
        let finalStatus = "Failed";

        const startTime = new Date();
        
        if (!isRetry) {
            this.emailReporter.addRecord(claimNumber, patientName, 'Started', startTime);
        }

        try {
            const licensePopupFound = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupFound) {
                console.log(`⏭️ Skipping claim ${claimNumber} due to license expired popup - DOS: ${displayDOS}`);
                finalStatus = "Failed - License Expired";
                
                if (fs.existsSync(tempFolder)) {
                    fs.rmSync(tempFolder, { recursive: true, force: true });
                }
                
                await this.updateRecordStatus(record._id, finalStatus, isRetry);
                this.emailReporter.updateRecordStatus(claimNumber, finalStatus);
                return finalStatus;
            }

            await this.ensureCleanState(page);

            const licensePopupAfterClean = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupAfterClean) {
                console.log(`⏭️ Skipping claim ${claimNumber} due to license expired popup (after clean state) - DOS: ${displayDOS}`);
                finalStatus = "Failed - License Expired";
                
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

            try {
                await page.waitForSelector('.modal.fade.bluetheme.billing-width.in', { state: 'visible', timeout: 20000 });
            } catch (error) {
                const licensePopupDuringSearch = await this.checkForLicenseExpiredPopup(page, claimNumber);
                if (licensePopupDuringSearch) {
                    console.log(`⏭️ Skipping claim ${claimNumber} due to license expired popup (during search) - DOS: ${displayDOS}`);
                    finalStatus = "Failed - License Expired";
                    
                    if (fs.existsSync(tempFolder)) {
                        fs.rmSync(tempFolder, { recursive: true, force: true });
                    }
                    
                    await this.updateRecordStatus(record._id, finalStatus, isRetry);
                    this.emailReporter.updateRecordStatus(claimNumber, finalStatus);
                    return finalStatus;
                }
                throw error;
            }

            const licensePopupBeforeHCFA = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupBeforeHCFA) {
                console.log(`⏭️ Skipping claim ${claimNumber} due to license expired popup (before HCFA) - DOS: ${displayDOS}`);
                finalStatus = "Failed - License Expired";
                
                if (fs.existsSync(tempFolder)) {
                    fs.rmSync(tempFolder, { recursive: true, force: true });
                }
                
                await this.updateRecordStatus(record._id, finalStatus, isRetry);
                this.emailReporter.updateRecordStatus(claimNumber, finalStatus);
                return finalStatus;
            }

            // 2️⃣ Download HCFA
            hcfaSuccess = await this.downloadHCFA(page, claimNumber, '', '', tempFolder, patientName);
            console.log(`✅ HCFA download ${hcfaSuccess ? 'successful' : 'failed'} for claim ${claimNumber} - DOS: ${displayDOS}`);

            const licensePopupAfterHCFA = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupAfterHCFA) {
                console.log(`⏭️ Skipping further processing for claim ${claimNumber} due to license expired popup - DOS: ${displayDOS}`);
                finalStatus = hcfaSuccess ? "Partially completed - License expired after HCFA" : "Failed - License Expired";
                
                if (!hcfaSuccess && fs.existsSync(tempFolder)) {
                    fs.rmSync(tempFolder, { recursive: true, force: true });
                }
                
                if (hcfaSuccess) {
                    // ✅ PASS ACCOUNT to organizeLocalFiles
                    await this.organizeLocalFiles(claimNumber, patientName, tempFolder, dos, account);
                    await this.uploadToSFTPFromLocal(claimNumber, patientName, dos);
                }
                
                await this.updateRecordStatus(record._id, finalStatus, isRetry);
                this.emailReporter.updateRecordStatus(claimNumber, finalStatus);
                return finalStatus;
            }

            // 3️⃣ Download Progress Note
            console.log(`📝 Downloading Progress Note for claim ${claimNumber} - DOS: ${displayDOS}`);
            progressNoteSuccess = await this.downloadProgressNote(page, claimNumber, patientName, '', '', context, tempFolder, dos, account);
            console.log(`✅ Progress Note ${progressNoteSuccess ? 'found' : 'NOT found'} for claim ${claimNumber} - DOS: ${displayDOS}`);

            if (!progressNoteSuccess) {
                console.log(`⏭️ Progress Note failed - Stopping further processing for claim ${claimNumber} - DOS: ${displayDOS}`);
                
                if (hcfaSuccess) {
                    finalStatus = "Partially completed - Progress Note failed (Hub flow executed)";
                } else {
                    finalStatus = "Failed - Progress Note failed";
                }
                
                if (hcfaSuccess) {
                    // ✅ PASS ACCOUNT to organizeLocalFiles
                    await this.organizeLocalFiles(claimNumber, patientName, tempFolder, dos, account);
                    await this.uploadToSFTPFromLocal(claimNumber, patientName, dos);
                } else {
                    if (fs.existsSync(tempFolder)) {
                        fs.rmSync(tempFolder, { recursive: true, force: true });
                    }
                }
                
                await this.updateRecordStatus(record._id, finalStatus, isRetry);
                this.emailReporter.updateRecordStatus(claimNumber, finalStatus);
                
                await this.ensureCleanState(page);
                return finalStatus;
            }

            const licensePopupAfterProgressNote = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupAfterProgressNote) {
                console.log(`⏭️ Skipping ERA processing for claim ${claimNumber} due to license expired popup - DOS: ${displayDOS}`);
                
                if (hcfaSuccess && progressNoteSuccess) {
                    finalStatus = "Partially completed - License expired after Progress Note";
                } else {
                    finalStatus = "Partially completed - License expired";
                }
                
                if (hcfaSuccess || progressNoteSuccess) {
                    // ✅ PASS ACCOUNT to organizeLocalFiles
                    await this.organizeLocalFiles(claimNumber, patientName, tempFolder, dos, account);
                    await this.uploadToSFTPFromLocal(claimNumber, patientName, dos);
                }
                
                await this.updateRecordStatus(record._id, finalStatus, isRetry);
                this.emailReporter.updateRecordStatus(claimNumber, finalStatus);
                return finalStatus;
            }

            // 4️⃣ Process ERA payments (ONLY if Progress Note succeeded)
            console.log(`💳 Processing ERA payments for claim ${claimNumber} - DOS: ${displayDOS}`);
            const eraResult = await this.processERAPayments(page, claimNumber, patientName, '', '', context, tempFolder);
            eraSuccess = eraResult.filesFetched > 0;
            console.log(`✅ ERA processing ${eraSuccess ? 'successful' : 'failed'} - downloaded ${eraResult.filesFetched} files for claim ${claimNumber} - DOS: ${displayDOS}`);

            const licensePopupAfterERA = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupAfterERA) {
                console.log(`ℹ️ License expired popup appeared after ERA processing for claim ${claimNumber} - DOS: ${displayDOS}`);
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

            console.log(`📊 Files fetched: ${successCount}/3 - Status: ${finalStatus} - DOS: ${displayDOS}`);

            if (successCount > 0) {
                // ✅ PASS ACCOUNT to organizeLocalFiles
                await this.organizeLocalFiles(claimNumber, patientName, tempFolder, dos, account);
                await this.uploadToSFTPFromLocal(claimNumber, patientName, dos);
            } else {
                if (fs.existsSync(tempFolder)) {
                    fs.rmSync(tempFolder, { recursive: true, force: true });
                }
            }

            await this.updateRecordStatus(record._id, finalStatus, isRetry);
            this.emailReporter.updateRecordStatus(claimNumber, finalStatus);

            console.log(`✅ Successfully processed claim ${claimNumber} - DOS: ${displayDOS} - Status: ${finalStatus}`);

            return finalStatus;

        } catch (error) {
            console.error(`❌ Failed to process claim ${claimNumber} - DOS: ${displayDOS}:`, error.message);
            finalStatus = "Failed";
            
            if (fs.existsSync(tempFolder)) {
                fs.rmSync(tempFolder, { recursive: true, force: true });
            }
            
            await this.updateRecordStatus(record._id, finalStatus, isRetry);
            this.emailReporter.updateRecordStatus(claimNumber, finalStatus);
            return finalStatus;
        } finally {
            console.log('🔄 Cleaning up before next claim...');
            await this.ensureCleanState(page);
        }
    }

   async downloadHCFA(page, claimNumber, charges, balance, tempFolder, patientName) {
    console.log(`📋 Downloading HCFA for claim ${claimNumber}...`);
    
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries) {
        try {
            // ✅ Clean up old HCFA files in temp folder first
            if (fs.existsSync(tempFolder)) {
                const files = fs.readdirSync(tempFolder);
                for (const file of files) {
                    if (file.startsWith('HCFA_')) {
                        const filePath = path.join(tempFolder, file);
                        try {
                            fs.unlinkSync(filePath);
                            console.log(`🗑️ Deleted old HCFA in temp: ${file}`);
                        } catch (e) {
                            // Ignore deletion errors
                        }
                    }
                }
            }
            
            await page.waitForSelector('[id^="printHCFADropDown"]', { state: 'visible', timeout: 10000 });
            await page.click('[id^="printHCFADropDown"]');
            await page.waitForTimeout(1000);
            
            const licensePopupBeforeClick = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupBeforeClick) {
                return false;
            }
            
            // Try multiple ways to click the HCFA link
            let hcfaClicked = false;
            
            // Method 1: Direct click using evaluate
            try {
                await page.evaluate(() => {
                    const link = document.querySelector('#billingClaimLink17');
                    if (link) {
                        link.click();
                        return true;
                    }
                    return false;
                });
                hcfaClicked = true;
            } catch (e) {
                console.log('Method 1 failed, trying method 2...');
            }
            
            // Method 2: Wait for and click the element directly
            if (!hcfaClicked) {
                try {
                    await page.waitForSelector('#billingClaimLink17', { timeout: 5000 });
                    await page.click('#billingClaimLink17');
                    hcfaClicked = true;
                } catch (e) {
                    console.log('Method 2 failed, trying method 3...');
                }
            }
            
            // Method 3: Try any HCFA link
            if (!hcfaClicked) {
                const hcfaLinks = await page.$$('a[id*="HCFA"], a:has-text("HCFA")');
                if (hcfaLinks.length > 0) {
                    await hcfaLinks[0].click();
                    hcfaClicked = true;
                }
            }
            
            if (!hcfaClicked) {
                console.log('❌ Could not find HCFA link');
                return false;
            }
            
            // Wait for modal
            try {
                await page.waitForSelector('.modal.claimforms-mod.in', { 
                    state: 'visible', 
                    timeout: 15000 
                });
            } catch (timeoutError) {
                const licensePopupDuringWait = await this.checkForLicenseExpiredPopup(page, claimNumber);
                if (licensePopupDuringWait) {
                    await page.keyboard.press('Escape');
                    return false;
                }
                
                // Try pressing escape and retry
                if (retryCount < maxRetries - 1) {
                    console.log(`⏳ Modal timeout, retrying... (${retryCount + 1}/${maxRetries})`);
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(2000);
                    retryCount++;
                    continue;
                }
                throw timeoutError;
            }
            
            const licensePopupAfterModal = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupAfterModal) {
                await page.keyboard.press('Escape');
                return false;
            }
            
            // Find the iframe with better error handling
            let iframeHandle;
            try {
                iframeHandle = await page.waitForSelector('#claimFormViewerFrame', { timeout: 10000 });
            } catch (error) {
                console.log('❌ Iframe not found, trying alternative selectors...');
                // Try alternative iframe selectors
                const iframes = await page.$$('iframe');
                for (const iframe of iframes) {
                    const src = await iframe.getAttribute('src');
                    if (src && src.includes('HCFAClaim')) {
                        iframeHandle = iframe;
                        break;
                    }
                }
                
                if (!iframeHandle) {
                    throw new Error('HCFA iframe not found');
                }
            }
            
            let iframeSrc = await iframeHandle.getAttribute('src');
            const baseUrl = new URL(page.url()).origin;
            if (!iframeSrc.startsWith('http')) {
                iframeSrc = baseUrl + iframeSrc;
            }
            
            console.log(`🌐 Fetching HCFA from: ${iframeSrc.substring(0, 100)}...`);
            
            // ✅ CRITICAL FIX: Use try-catch for the request to prevent Node.js crash
            let pdfResponse;
            try {
                pdfResponse = await page.request.get(iframeSrc, {
                    headers: {
                        'Referer': page.url(),
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    },
                    timeout: 30000
                }).catch(error => {
                    console.log(`⚠️ Request failed: ${error.message}`);
                    return null;
                });
            } catch (error) {
                console.log(`❌ Request error (catch block): ${error.message}`);
                if (retryCount < maxRetries - 1) {
                    retryCount++;
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(2000);
                    continue;
                }
                return false;
            }
            
            if (!pdfResponse) {
                console.log('❌ PDF response is null');
                if (retryCount < maxRetries - 1) {
                    retryCount++;
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(2000);
                    continue;
                }
                return false;
            }
            
            if (!pdfResponse.ok()) {
                console.log(`❌ PDF response not OK: ${pdfResponse.status()}`);
                if (retryCount < maxRetries - 1) {
                    retryCount++;
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(2000);
                    continue;
                }
                return false;
            }
            
            let pdfBuffer;
            try {
                pdfBuffer = await pdfResponse.body();
            } catch (error) {
                console.log(`❌ Failed to get PDF body: ${error.message}`);
                if (retryCount < maxRetries - 1) {
                    retryCount++;
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(2000);
                    continue;
                }
                return false;
            }
            
            if (!pdfBuffer || pdfBuffer.length === 0) {
                console.log('❌ PDF buffer is empty');
                if (retryCount < maxRetries - 1) {
                    retryCount++;
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(2000);
                    continue;
                }
                return false;
            }
            
            // ✅ Use run date format M-D-YY
            const runDate = getRunDate();
            const savePath = path.join(tempFolder, `HCFA_${claimNumber}-${runDate}.pdf`);
            
            try {
                fs.writeFileSync(savePath, pdfBuffer);
                console.log(`💾 HCFA PDF saved: ${savePath} (${Math.round(pdfBuffer.length / 1024)} KB)`);
            } catch (error) {
                console.log(`❌ Failed to save PDF: ${error.message}`);
                if (retryCount < maxRetries - 1) {
                    retryCount++;
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(2000);
                    continue;
                }
                return false;
            }
            
            await page.keyboard.press('Escape');
            await page.waitForTimeout(2000);
            
            // Wait for the main modal to be visible again
            try {
                await page.waitForSelector('.modal.fade.bluetheme.billing-width.in', { 
                    state: 'visible', 
                    timeout: 10000 
                });
            } catch (error) {
                console.log('⚠️ Main modal not visible after HCFA download');
            }
            
            return true;
            
        } catch (error) {
            // ✅ Handle specific Node.js internal assertion error
            if (error.code === 'ERR_INTERNAL_ASSERTION' || error.message.includes('internal assertion')) {
                console.error(`⚠️ Node.js internal assertion error for claim ${claimNumber}, retrying...`);
                
                if (retryCount < maxRetries - 1) {
                    retryCount++;
                    console.log(`🔄 Retrying HCFA download after internal error... (${retryCount}/${maxRetries})`);
                    
                    try {
                        // Try to press escape to close any open modals
                        await page.keyboard.press('Escape');
                        await page.waitForTimeout(2000);
                        await page.keyboard.press('Escape');
                        await page.waitForTimeout(2000);
                        
                        // Wait a bit before retrying
                        await page.waitForTimeout(5000);
                    } catch (e) {
                        // Ignore cleanup errors
                    }
                    
                    continue;
                }
                
                console.error(`❌ HCFA download failed after ${maxRetries} retries due to Node.js internal error`);
                return false;
            }
            
            console.error(`❌ HCFA download attempt ${retryCount + 1} failed for claim ${claimNumber}: ${error.message}`);
            
            if (retryCount < maxRetries - 1) {
                retryCount++;
                console.log(`🔄 Retrying HCFA download... (${retryCount}/${maxRetries})`);
                
                try {
                    // Try to press escape to close any open modals
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(2000);
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(2000);
                    
                    // Wait a bit before retrying
                    await page.waitForTimeout(3000);
                } catch (e) {
                    // Ignore cleanup errors
                }
                
                continue;
            }
            
            return false;
        }
    }
    
    return false;
}

   async downloadProgressNote(page, claimNumber, patientName, charges, balance, context, tempFolder, dos, account) {
    console.log(`📝 Downloading Progress Note for claim ${claimNumber}...`);
    
    try {
        console.log('📝 Looking for Progress Note button...');
        
        const licensePopupBeforeClick = await this.checkForLicenseExpiredPopup(page, claimNumber);
        if (licensePopupBeforeClick) {
            console.log('⚠️ License popup found, trying Hub Flow...');
            return await this.executeHubFlow(page, claimNumber, dos, tempFolder, patientName, account);
        }
        
        const progressNoteButton = await page.$('[id^="claimProgressNoteBtn"]');
        
        if (!progressNoteButton) {
            console.log('❌ Button not found, trying Hub Flow...');
            return await this.executeHubFlow(page, claimNumber, dos, tempFolder, patientName, account);
        }
        
        console.log('✅ Progress Note button found');
        
        const isEnabled = await progressNoteButton.isEnabled();
        
        if (!isEnabled) {
            console.log('⏭️ Button disabled, trying Hub Flow...');
            return await this.executeHubFlow(page, claimNumber, dos, tempFolder, patientName, account);
        }
        
        console.log('🖱️ Button is enabled - clicking...');
        await progressNoteButton.click();
        
        try {
            console.log('⏳ Waiting for Progress Note frame...');
            await page.waitForSelector('#ProgNoteViwerFrame', { timeout: 15000 });
            console.log('✅ Progress Note frame found');
            
            const licensePopupAfterFrame = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupAfterFrame) {
                await page.keyboard.press('Escape');
                await page.waitForTimeout(1000);
                console.log('⚠️ License popup after frame, trying Hub Flow...');
                return await this.executeHubFlow(page, claimNumber, dos, tempFolder, patientName, account);
            }
            
            const frameHandle = await page.$('#ProgNoteViwerFrame');
            if (!frameHandle) {
                console.log('❌ Frame handle not found, trying Hub Flow...');
                return await this.executeHubFlow(page, claimNumber, dos, tempFolder, patientName, account);
            }
            
            const frame = await frameHandle.contentFrame();
            if (!frame) {
                console.log('❌ Could not access frame, trying Hub Flow...');
                return await this.executeHubFlow(page, claimNumber, dos, tempFolder, patientName, account);
            }
            
            console.log('✅ Frame content loaded');
            
            // Wait for frame to be fully loaded
            await frame.waitForLoadState('networkidle');
            await page.waitForTimeout(2000); // Give extra time for content
            
            // Check if frame has any content at all
            const frameContent = await frame.evaluate(() => {
                return {
                    bodyText: document.body.innerText.trim(),
                    bodyHTML: document.body.innerHTML,
                    hasElements: document.body.children.length > 0,
                    textLength: document.body.innerText.length
                };
            });
            
            console.log(`📊 Frame stats: Text length=${frameContent.bodyText.length}, Has elements=${frameContent.hasElements}`);
            
            // If frame has minimal content, still proceed (might be a valid empty note)
            if (frameContent.bodyText.length < 20 && !frameContent.hasElements) {
                console.log('⚠️ Frame appears to be empty, trying Hub Flow...');
                await page.keyboard.press('Escape');
                await page.waitForTimeout(1000);
                return await this.executeHubFlow(page, claimNumber, dos, tempFolder, patientName, account);
            }
            
            // Try multiple selectors for note content
            const noteContent = await frame.evaluate(() => {
                // Try multiple selectors for progress note content
                const selectors = [
                    '.note-content',
                    '.progress-note',
                    '.clinical-note',
                    '[id*="note"]',
                    '[class*="note"]',
                    '.container',
                    '.content-area',
                    'div[style*="padding"]',
                    'div[style*="margin"]',
                    'table',
                    'form',
                    'div:has(p)',
                    'div:has(span)',
                    document.body // Fallback to body
                ];
                
                for (const selector of selectors) {
                    try {
                        const element = typeof selector === 'string' 
                            ? document.querySelector(selector)
                            : selector;
                        
                        if (element && element.innerHTML && element.innerHTML.length > 100) {
                            return element.outerHTML;
                        }
                    } catch (e) {
                        // Continue to next selector
                    }
                }
                
                return document.body.outerHTML;
            });
            
            // Create a clean HTML document with the content
            const htmlContent = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <style>
                        body { 
                            font-family: Arial, sans-serif; 
                            margin: 20px; 
                            line-height: 1.6;
                            color: #333;
                        }
                        .note-title {
                            font-size: 18px;
                            font-weight: bold;
                            margin-bottom: 20px;
                            color: #2c3e50;
                            border-bottom: 2px solid #3498db;
                            padding-bottom: 10px;
                        }
                        .note-section {
                            margin-bottom: 15px;
                        }
                        .note-label {
                            font-weight: bold;
                            color: #2c3e50;
                        }
                    </style>
                </head>
                <body>
                    <div class="note-title">Progress Note - Claim: ${claimNumber} - Patient: ${patientName}</div>
                    ${noteContent}
                </body>
                </html>
            `;
            
            // Create a temporary page to render the HTML
            const tempPage = await context.newPage();
            await tempPage.setContent(htmlContent, { waitUntil: 'load' });
            
            // ✅ FIXED: Use account number for filename
            const pdfPath = path.join(tempFolder, `ProgressNote_${claimNumber}-${account}.pdf`);
            
            console.log(`💾 Saving Progress Note as: ${path.basename(pdfPath)}`);
            
            // Generate PDF from the content
            await tempPage.pdf({ 
                path: pdfPath, 
                format: 'A4', 
                printBackground: true,
                margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
            });
            
            // Check if PDF was created successfully
            if (fs.existsSync(pdfPath)) {
                const stats = fs.statSync(pdfPath);
                console.log(`💾 Progress Note saved: ${path.basename(pdfPath)} (${Math.round(stats.size / 1024)} KB)`);
                
                // Even if PDF is small, it might be a valid empty note
                // Don't fall back to Hub Flow just because PDF is small
            } else {
                console.log(`❌ PDF not created, trying Hub Flow...`);
                await tempPage.close();
                await page.keyboard.press('Escape');
                await page.waitForTimeout(1000);
                return await this.executeHubFlow(page, claimNumber, dos, tempFolder, patientName, account);
            }
            
            await tempPage.close();
            
            // Close the Progress Note modal
            console.log('🚪 Closing Progress Note modal...');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(2000);
            
            // Wait for the main claim modal to be visible again
            try {
                await page.waitForSelector('.modal.fade.bluetheme.billing-width.in', { 
                    state: 'visible', 
                    timeout: 5000 
                });
                console.log('✅ Back to claim modal');
            } catch (error) {
                console.log('⚠️ Claim modal not visible, continuing...');
            }
            
            return true;
            
        } catch (frameError) {
            console.log(`⏰ Frame error: ${frameError.message}, trying Hub Flow...`);
            try {
                await page.keyboard.press('Escape');
                await page.waitForTimeout(1000);
            } catch (e) {}
            return await this.executeHubFlow(page, claimNumber, dos, tempFolder, patientName, account);
        }
        
    } catch (error) {
        console.error(`❌ Progress Note error: ${error.message}, trying Hub Flow...`);
        try {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);
        } catch (e) {}
        return await this.executeHubFlow(page, claimNumber, dos, tempFolder, patientName, account);
    }
}


    // ✅ FIXED: Download document file with proper workflow
async downloadPatientDocFile(fileLink, page, claimNumber, patientName, index, docObject, tempFolder, account) {
    try {
        console.log(`   📥 Attempting to download file #${index + 1}...`);
        
        const fileName = await fileLink.textContent();
        const cleanFileName = fileName ? fileName.trim() : `document_${index}`;
        console.log(`   📄 File: "${cleanFileName}"`);
        
        // Click to select file
        await fileLink.click({ force: true });
        await page.waitForTimeout(6000);
        
        // Right-click to open context menu
        const boundingBox = await fileLink.boundingBox();
        if (!boundingBox) {
            console.log(`   ❌ Element not visible for right-click`);
            return false;
        }
        
        // Try multiple right-click positions
        await page.mouse.click(
            boundingBox.x + boundingBox.width * 0.8,
            boundingBox.y + boundingBox.height / 2,
            { button: 'right' }
        );
        
        await page.waitForTimeout(10000);
        
        // Try multiple ways to find the context menu
        let targetMenu = null;
        
        // Try 1: Look for any dropdown menu
        const allMenus = await page.$$('ul.dropdown-menu[role="menu"], .dropdown-menu, [role="menu"]');
        
        for (let i = 0; i < allMenus.length; i++) {
            const menu = allMenus[i];
            const isVisible = await menu.isVisible();
            
            if (isVisible) {
                const menuText = await menu.textContent();
                if (menuText && menuText.toLowerCase().includes('download')) {
                    targetMenu = menu;
                    break;
                }
            }
        }
        
        // Try 2: If no menu found, check for direct download links
        if (!targetMenu) {
            const downloadLinks = await page.$$('a:has-text("Download"), button:has-text("Download")');
            for (const link of downloadLinks) {
                if (await link.isVisible()) {
                    console.log(`   ✅ Found direct Download link`);
                    await link.click();
                    await page.waitForTimeout(2000);
                    
                    // Wait for download
                    try {
                        const download = await page.waitForEvent('download', { timeout: 30000 });
                        return await this.handleDownloadFile(download, claimNumber, patientName, index, cleanFileName, tempFolder, account);
                    } catch (downloadError) {
                        console.log(`   ⚠️ No download event detected: ${downloadError.message}`);
                        return false;
                    }
                }
            }
        }
        
        if (!targetMenu) {
            console.log(`   ❌ No Download menu found`);
            
            // Try alternative: Look for any menu with options
            const allVisibleMenus = await page.$$('.modal-content, .popover, [role="dialog"]');
            for (const menu of allVisibleMenus) {
                const menuText = await menu.textContent();
                if (menuText && menuText.toLowerCase().includes('download')) {
                    console.log(`   🔍 Found alternative menu with download option`);
                    const downloadOption = await menu.$('*:has-text("Download"), *:has-text("download")');
                    if (downloadOption) {
                        await downloadOption.click();
                        await page.waitForTimeout(2000);
                        
                        try {
                            const download = await page.waitForEvent('download', { timeout: 30000 });
                            return await this.handleDownloadFile(download, claimNumber, patientName, index, cleanFileName, tempFolder, account);
                        } catch (downloadError) {
                            console.log(`   ⚠️ No download event from alternative menu: ${downloadError.message}`);
                            return false;
                        }
                    }
                }
            }
            
            return false;
        }
        
        // Click the Download option in the menu
        const downloadOption = await targetMenu.$('a:has-text("Download"), a:has-text("download")');
        
        if (downloadOption) {
            await downloadOption.click();
            console.log(`   ✅ Clicked Download option in menu`);
            
            // Wait for download
            try {
                const download = await page.waitForEvent('download', { timeout: 120000 });
                return await this.handleDownloadFile(download, claimNumber, patientName, index, cleanFileName, tempFolder, account);
            } catch (downloadError) {
                console.log(`   ⚠️ No download event detected: ${downloadError.message}`);
                return false;
            }
        }
        
        return false;
        
    } catch (error) {
        console.log(`   ❌ Download failed: ${error.message}`);
        return false;
    }
}

// ✅ NEW: Separate function to handle downloaded file
async handleDownloadFile(download, claimNumber, patientName, index, cleanFileName, tempFolder, account) {
    try {
        // ✅ Create clean suffix from filename
        let suffix = '';
        if (index === 0) {
            // First file: Use standard ProgressNote format
            suffix = '';
        } else {
            // Create meaningful suffix from filename
            const safeFileName = cleanFileName
                .replace(/[^a-zA-Z0-9]/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_+|_+$/g, '')
                .substring(0, 30)
                .trim();
            
            suffix = `_${index}_${safeFileName}`;
        }
        
        // ✅ TEMPORARY PATH: Download original file
        const tempPath = path.join(tempFolder, `Temp_ProgressNote_${claimNumber}-${account}${suffix}`);
        
        console.log(`   💾 Downloading to temporary file: ${path.basename(tempPath)}`);
        await download.saveAs(tempPath);
        
        // ✅ CRITICAL: Wait for file to be fully written
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        if (fs.existsSync(tempPath)) {
            const stats = fs.statSync(tempPath);
            
            // ✅ BETTER FILE TYPE DETECTION - Check HEX values
            const buffer = fs.readFileSync(tempPath, { length: 10 });
            const hexBytes = buffer.toString('hex', 0, 4); // Get first 4 bytes as hex
            const asciiBytes = buffer.toString('ascii', 0, 5); // Get first 5 bytes as ASCII
            
            console.log(`   🔍 File header: ASCII="${asciiBytes}", HEX="${hexBytes}"`);
            
            let finalPath = path.join(tempFolder, `ProgressNote_${claimNumber}-${account}${suffix}`);
            
            // Check if PDF (starts with %PDF-)
            if (asciiBytes === '%PDF-' || hexBytes.startsWith('25504446')) {
                console.log(`   📄 PDF file detected (${Math.round(stats.size / 1024)} KB)`);
                // Add .pdf extension
                finalPath = finalPath + '.pdf';
                fs.renameSync(tempPath, finalPath);
                console.log(`   ✅ PDF saved as: ${path.basename(finalPath)}`);
            } 
            // Skip TIFF files
            else if (hexBytes === '49492a00' || hexBytes === '4d4d002a' || 
                     asciiBytes.startsWith('II*') || asciiBytes.startsWith('MM*')) {
                console.log(`   ⚠️ SKIPPING TIFF file: ${cleanFileName} (not needed)`);
                fs.unlinkSync(tempPath);
                return false;
            }
            else {
                console.log(`   ❓ Unknown file type: ${asciiBytes} (hex: ${hexBytes})`);
                console.log(`   📏 File size: ${stats.size} bytes`);
                
                // Try to save with appropriate extension based on content
                if (asciiBytes.includes('<html') || asciiBytes.includes('<!DOCTYPE')) {
                    finalPath = finalPath + '.html';
                    fs.renameSync(tempPath, finalPath);
                    console.log(`   🌐 HTML file saved as: ${path.basename(finalPath)}`);
                } else {
                    finalPath = finalPath + '.unknown';
                    fs.renameSync(tempPath, finalPath);
                    console.log(`   ❓ Saved as unknown file type`);
                }
            }
            
            return true;
        } else {
            console.log(`   ❌ File not saved to disk`);
            return false;
        }
    } catch (error) {
        console.log(`   ❌ Error handling downloaded file: ${error.message}`);
        return false;
    }
}

    async traverseDocumentTree(page, container, dateRegex, claimNumber, tempFolder, patientName, depth = 0, account) {
        const indent = '  '.repeat(depth);
        let matchCount = 0;
        
        try {
            const containerSelector = await container.evaluate(el => {
                if (el.id) return `#${el.id}`;
                if (el.className) {
                    const classes = el.className.split(' ').filter(c => c).join('.');
                    return `.${classes}`;
                }
                return 'div[style="height:100%;width:100%; overflow:auto;"] ul#patientdocsUl1';
            });
            
            console.log(`${indent}🔍 Using container selector: ${containerSelector}`);
            
            const freshContainer = await page.$(containerSelector);
            if (!freshContainer) {
                console.log(`${indent}❌ Container not found`);
                return matchCount;
            }
            
            const allFileLinks = await freshContainer.$$('a[id^="patientdocsTreeLink"]');
            console.log(`${indent}📄 Found ${allFileLinks.length} file links`);
            
            for (let i = 0; i < allFileLinks.length; i++) {
                try {
                    const currentContainer = await page.$(containerSelector);
                    if (!currentContainer) {
                        console.log(`${indent}⚠️ Container disappeared`);
                        break;
                    }
                    
                    const currentLinks = await currentContainer.$$('a[id^="patientdocsTreeLink"]');
                    if (i >= currentLinks.length) {
                        console.log(`${indent}⚠️ Link ${i} no longer available`);
                        continue;
                    }
                    
                    const fileLink = currentLinks[i];
                    
                    const isConnected = await fileLink.evaluate(el => el.isConnected);
                    if (!isConnected) {
                        console.log(`${indent}⚠️ Link ${i} not connected`);
                        continue;
                    }
                    
                    const fileName = await fileLink.textContent();
                    if (!fileName || !fileName.trim()) {
                        continue;
                    }
                    
                    console.log(`${indent}🔍 Checking: "${fileName.trim().substring(0, 50)}..."`);
                    
                    if (dateRegex.test(fileName)) {
                        console.log(`${indent}  🎯 MATCH! Contains DOS pattern`);
                        
                        const docObjectAttr = await fileLink.getAttribute('document-object');
                        let docObject = { customname: fileName.trim(), label: fileName.trim() };
                        
                        if (docObjectAttr) {
                            try {
                                docObject = JSON.parse(docObjectAttr.replace(/&quot;/g, '"'));
                            } catch (e) {
                                // Use default object
                            }
                        }
                        
                        const success = await this.downloadPatientDocFile(fileLink, page, claimNumber, patientName, i, docObject, tempFolder, account);
                        if (success) {
                            matchCount++;
                            console.log(`${indent}  ✅ File downloaded`);
                        } else {
                            console.log(`${indent}  ❌ Download failed`);
                        }
                        
                        await page.waitForTimeout(1000);
                    }
                    
                } catch (error) {
                    console.log(`${indent}❌ Error processing file ${i}: ${error.message}`);
                }
            }
            
            return matchCount;
            
        } catch (error) {
            console.log(`${indent}❌ Error in traverseDocumentTree: ${error.message}`);
            return matchCount;
        }
    }

    async executeHubFlow(page, claimNumber, dos, tempFolder, patientName, account) {
        const displayDOS = dos ? moment.utc(dos).format('MM/DD/YYYY') : 'N/A';
        console.log(`🚀 STARTING HUB FLOW for claim ${claimNumber} - DOS: ${displayDOS} - Account: ${account}`);
        
        try {
            const hubButton = await page.$('[id^="claimPatientHub"]') || await page.$('button:has-text("Hub")');
            
            if (!hubButton) {
                console.log('❌ Hub button NOT FOUND');
                return false;
            }
            
            console.log('✅ Hub button found - CLICKING...');
            await hubButton.click();
            await page.waitForTimeout(4000);
            
            const patientDocsButton = await page.$('#patient-hubBtn11') || await page.$('button:has-text("Patient Docs")');
            
            if (!patientDocsButton) {
                console.log('❌ Patient Docs button NOT FOUND');
                await page.keyboard.press('Escape');
                return false;
            }
            
            console.log('✅ Patient Docs button found - CLICKING...');
            await patientDocsButton.click();
            await page.waitForTimeout(5000);
            
            const docContainer = await page.$('div[style="height:100%;width:100%; overflow:auto;"]');
            
            if (!docContainer) {
                console.log('❌ Document container not found');
                await page.keyboard.press('Escape');
                await page.waitForTimeout(1000);
                await page.keyboard.press('Escape');
                return false;
            }
            
            console.log('✅ Found document container');
            
            console.log(`📅 Creating regex for DOS: ${displayDOS}`);
            const dateRegex = this.createDOSDateRegex(dos);
            const matchCount = await this.traverseDocumentTree(page, docContainer, dateRegex, claimNumber, tempFolder, patientName, 0, account);
            
            console.log(`\n📊 Total files found matching DOS ${displayDOS}: ${matchCount}`);
            
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);
            await page.keyboard.press('Escape');
            
            console.log(`✅ HUB FLOW COMPLETED for claim ${claimNumber}`);
            return matchCount > 0;
            
        } catch (error) {
            console.error(`❌ HUB FLOW ERROR for claim ${claimNumber} (DOS: ${displayDOS}): ${error.message}`);
            
            try {
                await page.keyboard.press('Escape');
                await page.waitForTimeout(1000);
                await page.keyboard.press('Escape');
            } catch (e) {
                // Ignore
            }
            
            return false;
        }
    }

   createDOSDateRegex(dos) {
    if (!dos) {
        console.log('⚠️ No DOS provided, using generic date pattern');
        return /\b\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}\b/gi;
    }
    
    try {
        const date = moment.utc(dos);
        if (!date.isValid()) {
            console.log('⚠️ Invalid DOS, using fallback');
            return /\b\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}\b/gi;
        }
        
        const day = date.date();
        const month = date.month() + 1;
        const year = date.year();
        const shortYear = year % 100;
        
        const formattedDate = moment.utc(dos).format('MM/DD/YYYY');
        console.log(`📅 Creating regex for DOS: ${formattedDate} (Month: ${month}, Day: ${day}, Year: ${year})`);
        
        const patterns = [];
        
        // ✅ EXISTING PATTERNS - Standard formats
        patterns.push(`${month}[-\/.]${day}[-\/.](${shortYear}|${year})`);
        patterns.push(`${month.toString().padStart(2, '0')}[-\/.]${day.toString().padStart(2, '0')}[-\/.](${shortYear}|${year})`);
        patterns.push(`${month}[-\/.]${day.toString().padStart(2, '0')}[-\/.](${shortYear}|${year})`);
        patterns.push(`${month.toString().padStart(2, '0')}[-\/.]${day}[-\/.](${shortYear}|${year})`);
        
        // ✅ NEW: Your specific patterns - "3/2" format (Month/Day without year)
        // For DOS 3/21/25, this will match "3/2" (but careful!)
        patterns.push(`\\b${month}[-\/.]${day}\\b`);
        patterns.push(`\\b${month.toString().padStart(2, '0')}[-\/.]${day.toString().padStart(2, '0')}\\b`);
        
        // ✅ NEW: "MMH XR Chest 1 Front View) 3/2" format
        // This matches "3/2" at the end of string
        patterns.push(`${month}[-\/.]${day}(?!\\d)`);
        patterns.push(`${month.toString().padStart(2, '0')}[-\/.]${day.toString().padStart(2, '0')}(?!\\d)`);
        
        // ✅ NEW: "2503.21" format (DDMM.YY)
        // For 3/21/25 → Day=21, Month=3, Year=25 → "2103.25"
        // But you have "2503.21" which seems reversed
        patterns.push(`${day.toString().padStart(2, '0')}${month.toString().padStart(2, '0')}[-\/.]${shortYear}`);
        patterns.push(`${day}${month}[-\/.]${shortYear}`);
        patterns.push(`${shortYear}${month.toString().padStart(2, '0')}${day.toString().padStart(2, '0')}`); // "250321"
        patterns.push(`${shortYear}${month}${day}`); // "25321"
        
        // ✅ NEW: "2503.21" specific pattern (year.month.day?)
        // This matches "25" (year) "03" (month) "21" (day)
        patterns.push(`${shortYear}${month.toString().padStart(2, '0')}[-\/.]${day.toString().padStart(2, '0')}`); // "25.03.21"
        patterns.push(`${shortYear}[-\/.]${month.toString().padStart(2, '0')}[-\/.]${day.toString().padStart(2, '0')}`); // "25.03.21"
        
        // ✅ NEW: Reverse pattern "2103.25" (DDMM.YY)
        patterns.push(`${day.toString().padStart(2, '0')}${month.toString().padStart(2, '0')}[-\/.]${shortYear}`); // "2103.25"
        patterns.push(`${day}${month}[-\/.]${shortYear}`); // "213.25"
        
        // ✅ NEW: "CCR 2503.21" format with prefix
        patterns.push(`CCR[ _]${shortYear}${month.toString().padStart(2, '0')}[-\/.]${day.toString().padStart(2, '0')}`);
        patterns.push(`CCR[ _]${day.toString().padStart(2, '0')}${month.toString().padStart(2, '0')}[-\/.]${shortYear}`);
        
        // ✅ MMDD with year (no separators)
        patterns.push(`${month.toString().padStart(2, '0')}${day.toString().padStart(2, '0')}(${shortYear}|${year})`);
        patterns.push(`${month}${day}(${shortYear}|${year})`);
        
        // ✅ DD/MM/YYYY formats
        patterns.push(`${day}[-\/.]${month}[-\/.](${shortYear}|${year})`);
        patterns.push(`${day.toString().padStart(2, '0')}[-\/.]${month.toString().padStart(2, '0')}[-\/.](${shortYear}|${year})`);
        
        // ✅ MMDDYYYY (no separators, full year)
        patterns.push(`${month.toString().padStart(2, '0')}${day.toString().padStart(2, '0')}${year}`);
        patterns.push(`${month}${day}${year}`);
        
        // ✅ DD.MM.YY (with dots)
        patterns.push(`${day}[-\/.]${month}[-\/.]${shortYear}`);
        patterns.push(`${day.toString().padStart(2, '0')}[-\/.]${month.toString().padStart(2, '0')}[-\/.]${shortYear}`);
        
        // ✅ DDMM.YY (ECW specific)
        patterns.push(`${day.toString().padStart(2, '0')}${month.toString().padStart(2, '0')}[-\/.]${shortYear}`);
        patterns.push(`${day}${month}[-\/.]${shortYear}`);
        patterns.push(`${day.toString().padStart(2, '0')}${month.toString().padStart(2, '0')}[-\/.]${year}`);
        patterns.push(`${day}${month}[-\/.]${year}`);
        
        // ✅ Day/Month without year
        patterns.push(`\\b${day}[-\/.]${month}\\b`);
        patterns.push(`\\b${day.toString().padStart(2, '0')}[-\/.]${month.toString().padStart(2, '0')}\\b`);
        
        // ✅ YY.MM.DD format
        patterns.push(`${shortYear}[-\/.]${month}[-\/.]${day}`);
        patterns.push(`${shortYear}[-\/.]${month.toString().padStart(2, '0')}[-\/.]${day.toString().padStart(2, '0')}`);
        
        // ✅ YYYYMMDD format
        patterns.push(`${year}${month.toString().padStart(2, '0')}${day.toString().padStart(2, '0')}`);
        
        // ✅ Month-Day-Year with dashes only
        patterns.push(`${month}-${day}-(${shortYear}|${year})`);
        patterns.push(`${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}-(${shortYear}|${year})`);
        
        // ✅ Year-Month-Day formats
        patterns.push(`${year}[-\/.]${month}[-\/.]${day}`);
        patterns.push(`${year}[-\/.]${month.toString().padStart(2, '0')}[-\/.]${day.toString().padStart(2, '0')}`);
        
        const regex = new RegExp(`(?:${patterns.join('|')})`, 'gi');
        
        console.log(`✅ Created regex to match ${formattedDate} in ALL ECW formats`);
        console.log(`📋 Total patterns: ${patterns.length}`);
        
        // Show what we'll match for your specific examples
        console.log(`🔍 Will match your examples:`);
        console.log(`   - "MMH XR Chest 1 Front View) 3/2" → matches "3/2"`);
        console.log(`   - "MMH XR Chest 1 View Frontal 3/2" → matches "3/2"`);
        console.log(`   - "2503.21 CCR" → matches "2503.21" (as 25.03.21)`);
        
        return regex;
        
    } catch (error) {
        console.error(`❌ Error creating DOS regex: ${error.message}`);
        return /\b\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}\b/gi;
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
            const runDate = getRunDate();
            
            for (let i = 0; i < paymentRows.length; i++) {
                const row = paymentRows[i];
                
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
                    
                    const success = await this.processERARow(row, rowData, uniqueIdentifier, rowId, baseUrl, context, page, claimNumber, patientName, runDate, tempFolder);
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

           async processERARow(row, rowData, uniqueIdentifier, rowId, baseUrl, context, page, claimNumber, patientName, runDate, tempFolder) {
        console.log(`\n🖱️ Processing ERA for: ${rowData.payer} (Row ID: ${rowId})`);
        
        try {
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
                console.log('❌ ERA popup did not open');
                return false;
            }
            
            const licensePopupAfterERA = await this.checkForLicenseExpiredPopup(page, claimNumber);
            if (licensePopupAfterERA) {
                await page.keyboard.press('Escape');
                await page.waitForTimeout(1000);
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
                    
                    // ✅ IMPORTANT: Get payer name and clean it
                    const safePayer = rowData.payer 
                        ? rowData.payer.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30)
                        : 'UnknownPayer';
                    
                    const safePatient = patientName 
                        ? patientName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20)
                        : 'UnknownPatient';
                    
                    console.log(`📋 Payer: "${rowData.payer}" → "${safePayer}"`);
                    console.log(`📋 Patient: "${patientName}" → "${safePatient}"`);
                    
                    // ✅ CORRECT FORMAT: ERA_claimid-rundate_patient_payer_rowX.pdf
                    const eraPath = path.join(tempFolder, `ERA_${claimNumber}-${runDate}_${safePatient}_${safePayer}_${rowId}.pdf`);
                    
                    console.log(`💾 Saving ERA as: ${path.basename(eraPath)}`);
                    
                    if (eraHTML.includes('<html') || eraHTML.includes('<!DOCTYPE')) {
                        const eraPage = await context.newPage();
                        await eraPage.setContent(eraHTML, { waitUntil: 'networkidle' });
                        
                        await eraPage.pdf({ 
                            path: eraPath, 
                            format: 'A4', 
                            printBackground: true,
                            margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
                        });
                        
                        await eraPage.close();
                    } else {
                        fs.writeFileSync(eraPath, eraHTML);
                    }
                    
                    console.log(`✅ ERA saved: ${path.basename(eraPath)}`);
                    
                    // ✅ CLOSE THE ERA POPUP BEFORE PROCESSING NEXT ONE
                    console.log('🚪 Closing ERA popup...');
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(2000);
                    
                    // ✅ WAIT FOR THE CLAIM MODAL TO BE VISIBLE AGAIN
                    try {
                        await page.waitForSelector('.modal.fade.bluetheme.billing-width.in', { 
                            state: 'visible', 
                            timeout: 5000 
                        });
                        console.log('✅ Back to claim modal');
                    } catch (error) {
                        console.log('⚠️ Claim modal not visible, continuing anyway...');
                    }
                    
                    return true;
                }
            }
            
            // If we got here but couldn't process, try to close the popup
            console.log('🚪 Attempting to close ERA popup...');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);
            
            return false;
            
        } catch (error) {
            console.log(`❌ ERA processing failed: ${error.message}`);
            
            // Try to close any open popup on error
            try {
                await page.keyboard.press('Escape');
                await page.waitForTimeout(1000);
            } catch (e) {
                // Ignore
            }
            
            return false;
        }
    } // ← THIS CLOSING BRACKET WAS MISSING
} // ← THIS CLOSING BRACKET WAS MISSING

// Run the automation
if (require.main === module) {
    const automation = new ECWAutomation();
    automation.processAllRecords().catch(console.error);
}

module.exports = ECWAutomation;

