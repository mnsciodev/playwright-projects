const mongoose = require('mongoose');
 
const ClaimSchema = new mongoose.Schema({
  claimId: { type: String },
  claimStatus: { type: String },
  billingProviderName: { type: String },
  renderingProviderNpi: { type: String },
  renderingProviderName: { type: String },
  patientFirstName: { type: String },
  patientLastName: { type: String },
  patientState: { type: String },
  primaryPayerName: { type: String },
  primaryMemberId: { type: String },
  sumChargeAmountDollars: { type: String },  
  procedureCodes: { type: String }, // or [String] if array
  procedureModifiers: { type: String }, // or [String]
  dateOfService: { type: String },
  placeOfServiceCode: { type: String },
  diagnosisCodes: { type: String }, // or [String]
  comments: { type: String },
  status: { type: String },
  date: { type: Date, default: Date.now },
  user: { type: String },
  icn: { type: String },
  process: { type: String, enum: ["active", "inactive"], default: "inactive" }
},{
  timestamps:true
});
 
module.exports = mongoose.model('claims', ClaimSchema);