var mysql = require('mysql');
var DBConnectionLog = require("../Config/DBConnectionLog")
 
let host = "scio-pm-tool-db.cfhiwiste2j6.us-east-1.rds.amazonaws.com"
let user = "admin"
let password = "KwkNOSSpINNO3~6*#H$)Hv%S1Vks"
let database = "PM_Health"
// let ConnectionObject = {
//   host: process.env.DB_HOST ? process.env.DB_HOST : host,
//   user: process.env.DB_USER ? process.env.DB_USER : user,
//   password: process.env.DB_PASSWORD ? process.env.DB_PASSWORD : password,
//   database: process.env.DB_DATABASE ? process.env.DB_DATABASE : database,
// }
 
// var conn = mysql.createConnection(ConnectionObject);
// try {
//   conn.connect(function (err) {
//     if (err) {
//       DBConnectionLog.error(`MySql Connection Error ${JSON.stringify(err)} Connection String ${JSON.stringify(ConnectionObject)}`)
//     } else {
//       DBConnectionLog.info(`MySql DB Connected`)
//     }
//   });
// } catch (e) {
//   //DBConnectionLog.error(`MySql Connection Error Catch ${JSON.stringify(e)}`)
// }
 
const conn = mysql.createPool({
  host: process.env.DB_HOST ? process.env.DB_HOST : host,
  user: process.env.DB_USER ? process.env.DB_USER : user,
  password: process.env.DB_PASSWORD ? process.env.DB_PASSWORD : password,
  database: process.env.DB_DATABASE ? process.env.DB_DATABASE : database,
});
 
function handleDisconnect() {
  conn.getConnection((err, connection) => {
    if (err) {
      if (err.code === 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR') {
        DBConnectionLog.info('Fatal error: ', err);
        // Optionally, you can implement a reconnection strategy here
        setTimeout(handleDisconnect, 2000); // Attempt reconnection after 2 seconds
      } else {
        DBConnectionLog.info('Connection error: ', err);
      }
    }
    if (connection) {
      DBConnectionLog.info("DB Connected")
      connection.release();
    }
  });
}
 
conn.on('error', (err) => {
  DBConnectionLog.info('conn error: ', err);
  if (err.code === 'PROTOCOL_CONNECTION_LOST') {
    handleDisconnect();
  }
});
module.exports = conn;