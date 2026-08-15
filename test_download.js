const { downloadFile } = require('./src/drivers/storage');
const fs = require('fs');

async function test() {
    try {
        await downloadFile('81d80fa7-4520-4157-91d7-05a47ce5b2c1', 'test_ingestion_file.csv', './test_out.csv');
        console.log("Downloaded successfully!");
        console.log("Contents:");
        console.log(fs.readFileSync('./test_out.csv', 'utf8'));
    } catch (err) {
        console.error(err);
    }
}
test();
