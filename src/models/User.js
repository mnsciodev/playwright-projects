const mongoose = require('mongoose');
const Schema = mongoose.Schema;
 
const UsersSchema = new Schema({
    Login : { type: String },
    Password: { type: String },    
    ProviderName: { type: String },
    ICN: { type: String },
    Status: { type: String, default: "Active" },
});
 
module.exports = mongoose.model('userids', UsersSchema);