const storage = require('./src/drivers/storage');
async function run() {
    try {
        console.log("Cfg:", storage._minioCfg);
        const files = await storage.listFiles('minio');
        console.log(files);
    } catch(e) {
        console.error(e);
    }
}
run();
