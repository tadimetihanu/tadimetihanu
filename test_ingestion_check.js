const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');
const target = db.prepare("SELECT * FROM targets WHERE target_name LIKE '%MinIO%'").get();
console.log(target);

const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const s3 = new S3Client({
    endpoint: target.endpoint, 
    region: target.region || 'us-east-1', 
    credentials: {accessKeyId: target.access_key, secretAccessKey: target.secret_key}, 
    forcePathStyle: true
});

s3.send(new ListObjectsV2Command({Bucket: target.bucket})).then(r => {
    console.log("FILES:");
    console.log((r.Contents || []).map(o => o.Key).join("\n"));
}).catch(console.error);
