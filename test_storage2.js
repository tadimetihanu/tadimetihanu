require('dotenv').config();
const storage = require('./src/drivers/storage');
async function run() {
    try {
        console.log("Endpoint used:", storage._minioCfg.endpoint);
        const files = await storage.listFiles('minio');
        console.log("Success. Files count:", files.length);
    } catch(e) {
        console.error("FAIL:", e);
    }
}
run();
