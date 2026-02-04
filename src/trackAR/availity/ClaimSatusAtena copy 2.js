const { chromium } = require('playwright');
const ExcelJS = require('exceljs');

async function exportToExcel(finalData) {
    const workbook = new ExcelJS.Workbook();

    const summarySheet = workbook.addWorksheet('Claim_Summary');

    summarySheet.columns = [
        { header: 'Received Date', key: 'ReceivedDate', width: 15 },
        { header: 'Claim Number', key: 'claimNumber', width: 20 },
        { header: 'Final Claim Status', key: 'FinalClaimStatus', width: 18 },
        { header: 'Billed Amount', key: 'billedAmount', width: 15 },
        { header: 'Paid Amount', key: 'paidAmount', width: 15 },
        { header: 'Check Number', key: 'checkNumber', width: 15 },
        { header: 'Check Date', key: 'checkDate', width: 15 },
        { header: 'Check Amount', key: 'checkAmount', width: 15 }
    ];

    finalData.forEach(claim => {
        summarySheet.addRow({
            ReceivedDate: claim.ReceivedDate,
            claimNumber: claim.claimNumber,
            FinalClaimStatus: claim.FinalClaimStatus,
            billedAmount: claim.billedAmount,
            paidAmount: claim.paidAmount,
            checkNumber: claim.checkNumber,
            checkDate: claim.checkDate,
            checkAmount: claim.checkAmount
        });
    });

    const detailSheet = workbook.addWorksheet('Claim_Details');

    detailSheet.columns = [
        { header: 'Claim Number', key: 'claimNumber', width: 20 },
        { header: 'Check Number', key: 'checkNumber', width: 15 },
        { header: 'Check Date', key: 'checkDate', width: 15 },
        { header: 'Check Amount', key: 'checkAmount', width: 15 },
        { header: 'Claim Billed Amount', key: 'billedAmount', width: 15 },
        { header: 'Line Status', key: 'status', width: 15 },
        { header: 'Paid Amount', key: 'paidAmount', width: 15 },
        { header: 'Quantity', key: 'quantity', width: 10 },
        { header: 'Line Billed Amount', key: 'LineBilledAmount', width: 20 },
        { header: 'Procedure Code', key: 'ProcedureCode', width: 20 },
        { header: 'Procedure Qualifier', key: 'procedureQualifier', width: 20 },
        { header: 'DX Codes', key: 'dxCodes', width: 20 },
        { header: 'Reason Codes', key: 'reasonCodes', width: 25 },
        { header: 'Error Description', key: 'ErrorDescription', width: 25 },
        { header: 'Control Number', key: 'controlNumber', width: 20 },
        { header: 'Effective Date', key: 'effectiveDate', width: 15 },
        { header: 'Coinsurance', key: 'coinsurance', width: 15 },
        { header: 'Copay', key: 'copay', width: 15 },
        { header: 'Deductible', key: 'deductible', width: 15 },
        { header: 'Patient Responsibility', key: 'patientResponsibility', width: 20 }
    ];

    finalData.forEach(claim => {
        claim.ClaimLines.forEach(line => {
            detailSheet.addRow({
                ErrorDescription: line.ErrorDescription,
                LineBilledAmount: line.LineBilledAmount,
                ProcedureCode: line.ProcedureCode,
                status: line.status,
                paidAmount: line.paidAmount,
                quantity: line.quantity,
                procedureQualifier: line.procedureQualifier,
                dxCodes: line.dxCodes,
                reasonCodes: line.reasonCodes,
                controlNumber: line.controlNumber,
                effectiveDate: line.effectiveDate,
                coinsurance: line.coinsurance,
                copay: line.copay,
                deductible: line.deductible,
                patientResponsibility: line.patientResponsibility,

                MemberId: claim.MemberId,
                PatientFirstName: claim.PatientFirstName,
                PatientLastName: claim.PatientLastName,
                DateofBirth: claim.DateofBirth,
                DateOfService: claim.DateOfService,
                claimNumber: claim.claimNumber,
                billedAmount: claim.billedAmount,
                checkNumber: claim.checkNumber,
                checkDate: claim.checkDate,
                checkAmount: claim.checkAmount
            });
        });
    });

    await workbook.xlsx.writeFile('RCM_Claim_Report.xlsx');
    console.log('📊 Excel exported: RCM_Claim_Report.xlsx');
}
function parseAmount(Amount) {
    return Amount ? Amount.toString().replace(/[$,]/g, '') : ''
}
function parseMMDDYYYY(dateStr) {
    const [mm, dd, yyyy] = dateStr.split('/').map(Number);
    return new Date(yyyy, mm - 1, dd);
}
function trimToFirstSentence(text) {
    if (!text) return '';
    const cleaned = text.replace('Show more...', '').trim();
    const match = cleaned.match(/^[^.]*\./);
    return match ? match[0].trim() : cleaned;
}
const readPanel = async (frame, testId) => frame.locator(`[data-testid="${testId}"] p`).nth(1).innerText();
const readExpandedValue = async (container, label) => container.locator(`xpath=.//p[normalize-space()="${label}"]/following-sibling::*[1]`).innerText();
function calculateClaimStatusRCM(lineItems) {
    let netPaid = 0;
    let hasPaid = false;
    let hasDenied = false;

    for (const line of lineItems) {
        const paid = Number(line.paidAmount) || 0;
        netPaid += paid;

        if (line.status === 'PAID' && paid > 0) hasPaid = true;
        if (line.status === 'DENIED') hasDenied = true;
    }

    if (netPaid > 0 && hasDenied) return 'PARTIALLY PAID';
    if (netPaid > 0) return 'PAID';
    if (netPaid < 0) return 'REVERSED';
    if (netPaid === 0 && hasPaid) return 'DENIED'; // paid then reversed
    return 'DENIED';
}
function formatMMDDYYYY(date) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
}
function formatYYYYMMDD(date) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${yyyy}-${mm}-${dd}`;
}
function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}
function formatServiceDate(cellValue) {
    if (!cellValue) return '';

    // Excel date object
    if (cellValue instanceof Date) {
        const mm = String(cellValue.getMonth() + 1).padStart(2, '0');
        const dd = String(cellValue.getDate()).padStart(2, '0');
        const yyyy = cellValue.getFullYear();
        return `${mm}/${dd}/${yyyy}`;
    }

    // Already string
    return cellValue.toString().trim();
}

function splitPatientName(fullName) {
    if (!fullName) return { PatientLastName: '', PatientFirstName: '' };

    if (!fullName.includes(',')) {
        return { PatientLastName: fullName.trim(), PatientFirstName: '' };
    }

    const [last, first] = fullName.split(',');
    return {
        PatientLastName: last.trim(),
        PatientFirstName: first.trim()
    };
}
function formatDOB(cellValue) {
    if (!cellValue) return '';

    // If Excel date
    if (cellValue instanceof Date) {
        const yyyy = cellValue.getFullYear();
        const mm = String(cellValue.getMonth() + 1).padStart(2, '0');
        const dd = String(cellValue.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }

    // If text
    return cellValue.toString().trim();
}

async function readClaimsFromExcel(filePath) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const sheet = workbook.getWorksheet(1); // first sheet
    const records = [];

    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // skip header

        const fullName = row.getCell(3).text.trim();
        const { PatientLastName, PatientFirstName } = splitPatientName(fullName);

        records.push({
            MemberId: row.getCell(1).text.trim(),
            DateOfService: formatServiceDate(row.getCell(2).value),
            PatientLastName,
            PatientFirstName,
            DateofBirth: formatDOB(row.getCell(4).value)
        });
    });

    return records;
}

(async () => {
    const browser = await chromium.connectOverCDP('http://localhost:7000');
    const context = browser.contexts()[0];
    const page = context.pages().length ? context.pages()[0] : await context.newPage();

    try {
        console.log('🔄 Starting workflow');

        const cookies = page.locator('#onetrust-accept-btn-handler');
        if (await cookies.isVisible()) {
            await cookies.click();
            console.log('🍪 Cookies accepted');
        }

        await page.waitForLoadState('networkidle');

        await page.getByRole('button', { name: 'Claims & Payments' }).waitFor({ state: 'visible', timeout: 60000 });

        await page.getByRole('button', { name: 'Claims & Payments' }).click();

        await page.getByRole('link', { name: 'Claim Status' }).waitFor({ state: 'visible', timeout: 60000 });

        await page.getByRole('link', { name: 'Claim Status' }).click();

        await page.waitForSelector('iframe[name="newBody"]', {
            timeout: 60000
        });

        let frame;
        for (let i = 0; i < 30; i++) {
            frame = page.frame({ name: 'newBody' });
            if (frame) break;
            await page.waitForTimeout(1000);
        }

        if (!frame) throw new Error('❌ newBody iframe still not found');

        await frame.waitForSelector('form[data-testid="form-container"]', {
            timeout: 60000
        });

        await frame.locator('#orgSelect .organization-select__control').click({ force: true });

        await frame.getByRole('option', { name: 'ARCADIA MEDICAL ASSOCIATES, PA' }).click();

        await frame.locator('#payerSelect .payer-select__control').click({ force: true });

        await frame.waitForSelector('.payer-select__menu', { timeout: 60000 });

        await frame.locator('.payer-select__menu >> text=AMBETTER HEALTH').click();

        await frame.getByRole('button', { name: 'HIPAA Standard' }).click();

        await frame.getByRole('radio', {
            name: 'Org is Provider Radio Button-no'
        }).check();

        var FinalData = []

        const searchRecords = await readClaimsFromExcel('AvailiyClaimStatusAmbetterHealth.xlsx');
        console.log(`📘 Excel records loaded: ${searchRecords.length}`);

        for (const [index, record] of searchRecords.entries()) {


            await frame.locator("#subscriberMemberId").fill("")
            await frame.locator("#patientLastName").fill("");
            await frame.locator("#patientFirstName").fill("");
            await frame.locator("#patientBirthDate").fill("");
            await frame.locator("#fromDate").fill("");
            await frame.locator("#toDate").fill("");
            const MemberId = record.MemberId;
            const DateOfService = record.DateOfService;
            const PatientLastName = record.PatientLastName;
            const PatientFirstName = record.PatientFirstName;
            const DateofBirth = record.DateofBirth;

            const dos = parseMMDDYYYY(DateOfService);
            const expectedFrom = formatMMDDYYYY(addDays(dos, -2));
            const expectedTo = formatMMDDYYYY(addDays(dos, 1));

            const DateOfServiceStart = formatYYYYMMDD(addDays(dos, -2));
            const DateOfServiceEnd = formatYYYYMMDD(addDays(dos, 1));

            var InputData = {
                MemberId,
                PatientFirstName,
                PatientLastName,
                DateofBirth,
                DateOfService,
                DateOfServiceStart,
                DateOfServiceEnd
            }

            console.log(`Processing MemberId ${index} ${MemberId}, ${JSON.stringify(InputData)} `);

            await frame.locator("#subscriberMemberId").fill(InputData.MemberId);
            await frame.locator("#patientLastName").fill(InputData.PatientLastName);
            await frame.locator("#patientFirstName").fill(InputData.PatientFirstName);
            await frame.locator("#patientBirthDate").fill(InputData.DateofBirth);
            await frame.locator("#fromDate").fill(InputData.DateOfServiceStart);
            await frame.locator("#toDate").fill(InputData.DateOfServiceEnd);
            await frame.getByRole('button', { name: 'Submit' }).click();
            const alertBox = frame.locator('div.alert.alert-danger, div.alert.alert-warning');
            try {
                await alertBox.first().waitFor({ state: 'visible', timeout: 10000 });

                const alertText = (await alertBox.allInnerTexts()).join(' ').toLowerCase();

                if (
                    alertText.includes('data search unsuccessful') ||
                    (alertText.includes('claim') && alertText.includes('not found')) ||
                    alertText.includes('could not find any results')
                ) {
                    console.warn('❌ NO DATA', JSON.stringify(InputData), alertText);

                    FinalData.push({
                        ...InputData,
                        FinalClaimStatus: 'NO DATA FOUND'
                    });

                    continue; // ✅ next Excel record
                }
            } catch {
                // ✅ No alert → continue to results table
            }

            // ✅ Now wait ONLY for table
            const rows = frame.locator('#claimsTable tbody tr');

            try {
                await rows.first().waitFor({ state: 'visible', timeout: 20000 });
            } catch {
                console.warn(`⚠️ No claims table found for MemberId ${InputData.MemberId}`);

                FinalData.push({
                    ...InputData,
                    FinalClaimStatus: 'NO CLAIM TABLE'
                });

                continue;
            }

            const rowCount = await rows.count();
            if (rowCount === 0) {
                console.warn(`⚠️ No claims table found for MemberId ${MemberId}`);

                FinalData.push({
                    ...InputData,
                    FinalClaimStatus: 'NO CLAIM TABLE'
                });

                continue; // ✅ move to next Excel record
            }
            for (let i = 0; i < rowCount; i++) {
                const row = rows.nth(i);
                const text = await row.innerText();

                if (text.includes(expectedFrom) && text.includes(expectedTo)) {
                    console.log(`Claims Table Index ${i}`);
                    await row.click();

                    await frame.waitForSelector(
                        '[data-testid="testClaim NumberPanel"]',
                        { timeout: 60000 }
                    );
                    const summary = {
                        ...InputData,
                        AccountNumber: await readPanel(frame, 'testPatient Account NumberPanel'),
                        ReceivedDate: await readPanel(frame, 'testReceived DatePanel'),
                        claimNumber: await readPanel(frame, 'testClaim NumberPanel'),
                        claimStatus: await frame.locator('[data-testid="testClaim StatusPanel"] span').innerText(),
                        billedAmount: parseAmount(await readPanel(frame, 'testBilled AmountPanel')),
                        paidAmount: parseAmount(await readPanel(frame, 'testPaid AmountPanel')),
                        checkNumber: await readPanel(frame, 'testCheck NumberPanel'),
                        checkDate: await readPanel(frame, 'testCheck DatePanel'),
                        checkAmount: parseAmount(await readPanel(frame, 'testCheck AmountPanel')),
                        ClaimLines: [],
                        FinalClaimStatus: ""
                    };

                    let allRows;
                    let totalRows = 0;

                    try {
                        await frame.waitForSelector('#lineLevelTable tbody tr[role="row"]', {
                            timeout: 15000
                        });

                        allRows = frame.locator('#lineLevelTable tbody tr[role="row"]');
                        totalRows = await allRows.count();

                        for (let j = 0; j < totalRows; j++) {
                            console.log("Line Level Index", j)
                            const row = allRows.nth(j);

                            const serviceDatesText = await row.locator('td').nth(3).innerText();
                            //if (!serviceDatesText.includes(DateOfService)) continue;
                            const rowText = await row.innerText();
                            //if (!rowText.includes(DateOfService)) continue;

                            const LineBilledAmount = await row.locator('td').nth(7).innerText();
                            const ProcedureCode = await row.locator('td').nth(4).innerText();
                            const paidText = await row.locator('td').nth(6).innerText();
                            const statusText = await row.locator('td').nth(2).innerText();

                            const paidAmount = Number(
                                paidText.replace('$', '').replace(',', '').trim()
                            );

                            const expandBtn = row.locator('button[title="Toggle Row Expanded"]');
                            if (!(await expandBtn.count())) continue;


                            await expandBtn.click();

                            const expandedRow = row.locator('xpath=following-sibling::tr[1]');
                            await expandedRow.waitFor({ state: 'visible', timeout: 30000 });

                            const container = expandedRow.locator('div.p-3');

                            await frame.waitForSelector('#codesTable tbody tr', { timeout: 60000 });

                            var CommaString = await readExpandedValue(container, 'Reason/Remark Codes')

                            var reasonCodes = CommaString.split(',').map(c => c.trim()).filter(Boolean)

                            const reasonSet = new Set(reasonCodes);

                            const codeRows = frame.locator('#codesTable tbody tr');
                            const codeCount = await codeRows.count();
                            const ErrorDescription = [];

                            for (let k = 0; k < codeCount; k++) {
                                const row = codeRows.nth(k);
                                const type = (await row.locator('td').nth(0).innerText()).trim();
                                const code = (await row.locator('td').nth(1).innerText()).trim();
                                let rawDescription = await row.locator('td').nth(2).innerText();
                                let description = trimToFirstSentence(rawDescription);
                                if (reasonSet.has(code)) {
                                    ErrorDescription.push(`${code} - ${description}`);
                                    //matchedCodes.push({ type, code, description });
                                }
                            }
                            summary.ClaimLines.push({
                                ErrorDescription: ErrorDescription.join('\r\n'),
                                ProcedureCode: ProcedureCode,
                                status: statusText.trim(),
                                paidAmount,
                                reasonCodes: CommaString,
                                quantity: await readExpandedValue(container, 'Quantity'),
                                procedureQualifier: await readExpandedValue(container, 'Procedure Qualifier Code'),
                                dxCodes: await readExpandedValue(container, 'DX Code'),
                                controlNumber: await readExpandedValue(container, 'Control Number'),
                                effectiveDate: await readExpandedValue(container, 'Effective Date'),

                                LineBilledAmount: parseAmount(LineBilledAmount),
                                coinsurance: parseAmount(await readExpandedValue(container, 'Coinsurance')),
                                copay: parseAmount(await readExpandedValue(container, 'Copay')),
                                deductible: parseAmount(await readExpandedValue(container, 'Deductible')),
                                patientResponsibility: parseAmount(await readExpandedValue(container, 'Patient Responsibility')),
                            });
                        }
                        summary.FinalClaimStatus = calculateClaimStatusRCM(summary.ClaimLines);
                        if (summary.ClaimLines.length === 0) {
                            console.warn(`⚠️ No line details found for DOS ${DateOfService}`);
                        }
                        FinalData.push(summary)
                        await frame.locator('#rtrn2Rslts').nth(0).click();
                    } catch (err) {
                        console.warn('⚠️ No line-level table found for claim:', summary.claimNumber);

                        summary.ClaimLines = [];
                        summary.FinalClaimStatus = 'NO LINE DETAILS';

                        FinalData.push(summary);

                        await frame.locator('#rtrn2Rslts').first().click();
                        break; // move to next claim
                    }
                }
            }
        }
        console.log('🎉 Workflow completed');
        await exportToExcel(FinalData);
    } catch (err) {
        console.error('❌ Workflow failed:', err);
        await page.screenshot({ path: 'error.png', fullPage: true });
    }
    finally {
        if (FinalData.length > 0) {
            console.log(`💾 Saving ${FinalData.length} records to Excel...`);
            await exportToExcel(FinalData);
        } else {
            console.warn('⚠️ No data collected. Excel not generated.');
        }
    }
})();