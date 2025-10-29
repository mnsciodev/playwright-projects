const SimpleNodeLogger = require('simple-node-logger');
const opts = {
    logFilePath:'dbconnection.log',
    timestampFormat:'YYYY-MM-DD HH:mm:ss.SSS'
};
const DBConnectionLog = SimpleNodeLogger.createSimpleLogger(opts);
module.exports = DBConnectionLog;