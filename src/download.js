
const express = require('express');
const { MongoClient } = require('mongodb');
const ExcelJS = require('exceljs');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
MONGO_URI = "mongodb://localhost:27017"

// Connect to MongoDB
const client = new MongoClient(MONGO_URI, { useUnifiedTopology: true });

async function getDataGroupedByDateOfService() {
    await client.connect();
    const db = client.db('waystar'); // replace with your DB
    const collection = db.collection('benefit'); // replace with your collection

    const groupedData = await collection.aggregate([
        {
            $group: {
                _id: "$Date of Service", // Use exact field name
                records: { $push: "$$ROOT" },
            }
        },
        {
            $sort: { _id: 1 }
        }
    ]).toArray();

    return groupedData;
}
const sanitizeFileName = (name) => {
    return String(name)
        .replace(/[\/\\?%*:|"<>]/g, '-') // Replace invalid Windows filename chars
        .trim();
};
app.get('/download-excel', async (req, res) => {
    try {
        const data = await getDataGroupedByDateOfService();

        // Create a temporary folder to store Excel files
        const tempDir = path.join(__dirname, 'temp_excel');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

        const filePaths = [];
        for (const item of data) {
            const workbook = new ExcelJS.Workbook();
            const sheet = workbook.addWorksheet('Data');


            const sampleRecord = { ...item.records[0] };
            delete sampleRecord._id; // remove _id from header
            sheet.columns = Object.keys(sampleRecord).map(key => ({
                header: key,
                key,
                width: 20
            }));

            // Add rows without _id
            item.records.forEach(record => {
                const row = { ...record };
                delete row._id;
                sheet.addRow(row);
            });

            // Sanitize filename to avoid Windows invalid characters
            const fileName = `Data_${sanitizeFileName(item._id)}.xlsx`;
            const filePath = path.join(tempDir, fileName);
            await workbook.xlsx.writeFile(filePath);
            filePaths.push({ path: filePath, name: fileName });
        }


        // Zip all files
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename=excel_files.zip');

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        filePaths.forEach(file => {
            archive.file(file.path, { name: file.name });
        });

        await archive.finalize();

        // Cleanup temp folder after streaming
        archive.on('end', () => {
            filePaths.forEach(file => fs.unlinkSync(file.path));
            fs.rmdirSync(tempDir);
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating Excel files');
    } finally {
        await client.close();
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
