const { MongoClient, ObjectId } = require("mongodb");

const client = new MongoClient("mongodb+srv://scioms:5NHRcnbEjLaXefKF@scioms.n5hcu.mongodb.net/trizetto?retryWrites=true&w=majority");
const dbName = "trizetto";

async function connectDB() {
    if (!client.topology?.isConnected()) {
        await client.connect();
    }
    return client.db(dbName);
}

async function getDataFromMongo(db) {
    const collection = db.collection("benifitmasters");
    return await collection.find({
        SuccessCode: "Ready",
        GediPayerID: "66901",
        PracticeId: new ObjectId("641d3c30aabef30b0a779650")
    }).toArray();
}

async function updateProgress(db, recordId, message) {
    const collection = db.collection("benifitmasters");
    const _id = typeof recordId === "string" ? new ObjectId(recordId) : recordId;
    return await collection.updateOne(
        { _id },
        { $set: { SuccessCode: "Success", BannerRemarks: message } }
    );
}

module.exports = { connectDB, getDataFromMongo, updateProgress };
