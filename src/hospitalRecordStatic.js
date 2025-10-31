const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const moment = require("moment")
const fs = require('fs');
const nodemailer = require('nodemailer'); // ✅ Added for email support
const XLSX = require('xlsx'); // ✅ for Excel export
const { mouse } = require("@computer-use/nut-js");
mouse.config.mouseSpeed = 800;

// MongoDB connection setup
const uri = 'mongodb://localhost:27017/'; // update your DB URI
const client = new MongoClient(uri);


// ✅ Configure email transporter
const transporter = nodemailer.createTransport({
    host: "smtp.office365.com",
    port: 587,
    auth: {
        user: "trackar@scioms.com",
        pass: "Qow22964"
    }
});

// ✅ Helper: Send completion email
async function sendCompletionMail(totalPatients, successCount, failCount, startTime, endTime, excelPath) {
    const mailOptions = {
        from: '"SCIO Automation Hospital Records" <trackar@scioms.com>',
        to: ["nshree@scioms.com"],
        cc: ['sudha@scioms.com', 'jganesh@scioms.com',"rathi@scioms.com","mnavaladi@scioms.com"],
        subject: `Hospital Records and Patient Document Running Report ${moment().format("MM/DD/YYYY")}`,
        html: `
            <h2>Automation Run Summary</h2>
            <p><b>Total Patients:</b> ${totalPatients}</p>
            <p><b>Success:</b> ${successCount}</p>
            <p><b>Failed:</b> ${failCount}</p>
            <hr/>
            <p><b>Start Time :</b> ${moment(startTime).format("MM/DD/YYYY HH:mm:ss")} </p>
            <p><b>End Time :</b> ${moment(endTime).format("MM/DD/YYYY HH:mm:ss")} </p>
            <p><b>Duration:</b> ${moment(endTime).diff(moment(startTime), 'minutes')} minutes</p>
            <hr/>
               <p>📎 The detailed report is attached as an Excel file.</p>
            <p>This is an automated message from the SCIO Automation PlayWright.</p>
        `,
        attachments: [
            {
                filename: 'Automation_Report.xlsx',
                path: excelPath
            }
        ]
    };

    try {
        await transporter.sendMail(mailOptions);
        console.info('Completion email sent successfully');
    } catch (err) {
        console.error('❌ Failed to send completion email:', err);
    }
}

(async () => {
    let successCount = 0;
    let failCount = 0;
    const startTime = moment(); // ✅ Track automation start time
    const processedRecords = [];  // ✅ Store for Excel

    try {
        await client.connect();
        const database = client.db('amammh');
        const patientsCollection = database.collection('mmhmanual');
        var CurrentDate = moment().format("MMDDYYYY")
        const patientsCursor = patientsCollection.find({
            Ready: "Pending",
        });
        const patients = await patientsCursor.toArray();

        if (patients.length === 0) {
            console.log('No patients found in DB');
            const endTime = moment();
            await sendCompletionMail(0, 0, 0, startTime, endTime, null);
            return;
        }

        console.log(`Found ${patients.length} patients in DB`);

        const browser = await chromium.connectOverCDP('http://localhost:9222');
        const context = browser.contexts()[0];
        const page = context.pages().length ? context.pages()[0] : await context.newPage();

        // Go to the ECW login page
        await page.goto('https://tuxdtzathdedifgtvtapp.ecwcloud.com/mobiledoc/jsp/webemr/login/newLogin.jsp', { waitUntil: 'domcontentloaded' });

        // Wait for and type Doctor ID
        await page.waitForSelector('#doctorID');
        await page.fill('#doctorID', 'jganeshscio');

        // Click the "Next" button (adjust selector if needed)
        await page.click('#nextStep');

        // Wait for password field to appear
        await page.waitForSelector('#passwordField');
        await page.fill('#passwordField', 'Changeme@1014');

        // Wait for CAPTCHA auto tick
        await page.waitForTimeout(3000);

        const maxRetries = 3;
        let loginSuccess = false;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`🔁 Attempt ${attempt}: Clicking Login...`);
                await page.click('#Login', { timeout: 5000 });

                // Wait for network idle or partial navigation
                await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

                // Actively wait and recheck title for up to 15 seconds
                for (let i = 0; i < 15; i++) {
                    const title = await page.title();
                    if (title.includes('eCW (Ganesh, Jai ) Production Environment')) {
                        console.log('✅ Login successful!');
                        loginSuccess = true;
                        break;
                    }
                    await page.waitForTimeout(1000); // check again after 1 second
                }

                if (loginSuccess) break;
                else throw new Error('Title not matched yet');
            } catch (error) {
                console.log(`⚠️ Attempt ${attempt} failed: ${error.message}`);
                if (attempt < maxRetries) {
                    console.log('⏳ Retrying in 3 seconds...');
                    await page.waitForTimeout(3000);
                } else {
                    console.log('❌ All retry attempts failed.');
                }
            }
        }

        if (!loginSuccess) {
            await sendCompletionMail("Login Attempt Failed", 0, 0, startTime, endTime, null);
            console.log('❌ Could not confirm login — please check CAPTCHA or credentials.');
        }
        for (const patient of patients) {
            let status = 'Pending';
            let errorMsg = '';
            try {

                console.log(`\nProcessing patient: ${patient['Patient name']}, ${patient['DOB']}`);

                await page.locator('#jellybean-panelLink65').click();
                await page.waitForSelector('#searchText', { state: 'visible' });

                // Get patient name
                const fullName = patient['Patient name'].trim();
                let shortName = '';

                // Check if the name contains a comma
                if (fullName.includes(',')) {
                    // Split by comma, take first part, and trim spaces
                    shortName = fullName.split(',')[0].trim();
                } else {
                    // Split by spaces or commas and take first two words
                    const nameParts = fullName.split(/[\s,]+/);

                    if (nameParts.length >= 2) {
                        shortName = nameParts.slice(0, 2).join(' ');
                    } else {
                        shortName = nameParts[0];
                    }
                }

                // Fill the search field
                await page.fill('#searchText', shortName);


                await page.type('#patientSearchIpt3', moment(patient['DOB']).format("MMDDYYYY"));

                await page.waitForTimeout(2000);
                // Wait for modal and table to be visible
                await page.waitForSelector('#pt-lookup-modal-dialog', { state: 'attached' });
                await page.waitForSelector('#pt-lookup-modal-dialog #rule-table2', { state: 'attached' });

                const tableLocator = page.locator('#pt-lookup-modal-dialog #rule-table2').first();

                const rowCount = await tableLocator.locator('tr').count();
                console.log(`Row count: ${rowCount} ${typeof rowCount}`);

                if (rowCount === 0) {
                    failCount++;

                    status = 'Failed';
                    errorMsg = 'Patient Not Found';
                    console.log("Patient Not Found")
                    await patientsCollection.updateOne({ _id: patient._id }, {
                        $set: {
                            Ready: 'Failed',
                            error: "Patient Not Found",
                        }
                    });
                    await page.click('#patientSearchBtn1');

                    continue; // Continue loop even after error

                }

                const patientLastName = page.locator('#patientLName1');
                await patientLastName.click();

                await page.waitForSelector('#patient_hub', { state: 'visible' });
                const patientDocsButton = page.locator('#patient-hubBtn11');

                await patientDocsButton.click();

                await page.waitForSelector('#modalPatientDocs', { state: 'visible' });

                const hospitalRecordsFolder = page.locator('#modalPatientDocs a.active', { hasText: "Hospital Records" }).first();

                await hospitalRecordsFolder.click();

                const [fileChooser] = await Promise.all([
                    page.waitForEvent('filechooser'),
                    page.locator('#modalPatientDocs #patientdocsBtn4').click(),
                ]);

                var filesToUpload = `C:\\Users\\madhan.n\\OneDrive - SCIO Management Solutions (1)\\mmh\\manual\\${patient.FileName}`
                await fileChooser.setFiles(filesToUpload);

                const closeModal = async (modalSelector, closeBtnSelector, modalName) => {
                    const modal = page.locator(modalSelector);
                    await modal.waitFor({ state: 'visible' });
                    await modal.locator(closeBtnSelector).first().click();
                    try {
                        await modal.waitFor({ state: 'hidden', timeout: 3000 });
                        console.log(`${modalName} closed successfully`);
                    } catch {
                        console.log(`${modalName} is still visible`);
                    }
                };

                await closeModal('#documentReferal', '.modal-header >> #savePrompt-tplBtn1', 'Document Referral Modal');
                await closeModal('#modalPatientDocs', '.modal-header >> #savePrompt-tplBtn1', 'Patient Docs Modal');
                await closeModal('#patient_hub', '.modal-header >> #patient-hubBtn1', 'Patient Hub Modal');

                await patientsCollection.updateOne({ _id: patient._id }, {
                    $set: {
                        Ready: 'Done',
                    }
                });
                status = 'Done';
                successCount++;
                console.info(`Successfully processed ${patient['Patient name']}, ${patient['DOB']}`);
            } catch (err) {
                await patientsCollection.updateOne({ _id: patient._id }, {
                    $set: {
                        Ready: 'Failed',
                        error: err.message,
                    }
                });
                failCount++;
                status = 'Failed';
                errorMsg = err.message;
                continue; // Continue loop even after error
            }

            processedRecords.push({
                ...patient,
                Ready: patient.Ready,
                Status: status,
                Error: errorMsg
            });
        }
        const endTime = moment();
        // ✅ Create Excel report
        const ws = XLSX.utils.json_to_sheet(processedRecords);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Automation Report");

        const reportPath = `./Automation_Report_${moment().format("YYYYMMDD_HHmmss")}.xlsx`;
        XLSX.writeFile(wb, reportPath);
        console.log(`Excel report created at: ${reportPath}`);


        console.log('All patients processed successfully');

        try {
            await sendCompletionMail(
                processedRecords.length,
                successCount,
                failCount,
                startTime,
                endTime,
                reportPath
            );

            if (fs.existsSync(reportPath)) {
                fs.unlinkSync(reportPath);
                console.log(`Deleted temporary report file: ${reportPath}`);
            }
        } catch (err) {
            console.error('Error sending mail or deleting report:', err);
        }
    } catch (err) {
        console.error('Error in workflow:', err);

    } finally {
        await client.close();
    }
})();