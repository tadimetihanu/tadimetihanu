const fs = require('fs');
const path = require('path');

const dataDir = './data';
const bucketDir = path.join(dataDir, 'datalake');

if (!fs.existsSync(bucketDir)) fs.mkdirSync(bucketDir);

const files = fs.readdirSync(dataDir);
files.forEach(f => {
    const fullPath = path.join(dataDir, f);
    if (!fs.lstatSync(fullPath).isFile()) return;
    if (f === 'metadata.db') return;
    
    fs.renameSync(fullPath, path.join(bucketDir, f));
});
console.log('Successfully organized MinIO datalake');
