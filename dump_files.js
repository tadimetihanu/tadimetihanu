const { listFiles } = require('./src/drivers/storage');
const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');
const target = db.prepare("SELECT * FROM targets WHERE target_id = 'c6134ffb-9803-4b4e-a9f7-84f0ac067e'").get();
console.log('Target ID:', target.target_id);
console.log('Provider:', target.provider_type);
console.log('Endpoint:', target.endpoint);
console.log('Bucket:', target.bucket);

listFiles(target.target_id).then(files => {
    console.log('SUCCESS! Found:', files.length, 'files');
    console.log('First file:', files[0]?.name);
}).catch(err => {
    console.error('FAILED!', err.message);
});
