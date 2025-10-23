// config.js - Fix the duplicate exports
 
import mongoose from "mongoose";
 
export const Config = {
  secretOrKey: "secret",
  App_Url: "http://localhost:3011",
  mongoURI: "mongodb+srv://scioms:5NHRcnbEjLaXefKF@scioms.n5hcu.mongodb.net/scyotools?retryWrites=true&w=majority",
};
 
// Connect to MongoDB using mongoose
mongoose
  .connect(Config.mongoURI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 120000,
  })
  .then(() => console.log("✅ MongoDB connected successfully"))
  .catch((err) => console.error("❌ MongoDB connection error:", err.message));
 
export default Config;