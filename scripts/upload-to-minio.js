const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs   = require('fs');
const path = require('path');

const client = new S3Client({
    endpoint:    'http://localhost:9000',
    region:      'us-east-1',
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    forcePathStyle: true,
});

const BUCKET   = 'datainseek';
const DATA_DIR = path.join(__dirname, '../data');

const MIME = { parquet: 'application/octet-stream', csv: 'text/csv', json: 'application/json' };

(async () => {
    const files = fs.readdirSync(DATA_DIR).filter(f => /\.(parquet|csv|json)$/.test(f));
    console.log(`Uploading ${files.length} files to bucket: ${BUCKET}\n`);
    for (const fname of files) {
        try {
            const buf = fs.readFileSync(path.join(DATA_DIR, fname));
            const ext = fname.split('.').pop().toLowerCase();
            await client.send(new PutObjectCommand({
                Bucket:      BUCKET,
                Key:         fname,
                Body:        buf,
                ContentType: MIME[ext] || 'application/octet-stream',
            }));
            console.log(`✅  ${fname}  (${(buf.length / 1024).toFixed(1)} KB)`);
        } catch (e) {
            console.error(`❌  ${fname}:`, e.message);
        }
    }
    console.log('\n🎉 Done');
})();
