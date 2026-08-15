const { S3Client, CreateBucketCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const client = new S3Client({
    endpoint: 'http://localhost:9010',
    region: 'us-east-1',
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    forcePathStyle: true,
});

async function run() {
    try {
        await client.send(new CreateBucketCommand({ Bucket: 'datalake' }));
        console.log('Bucket "datalake" created.');
    } catch (e) {
        if (e.name === 'BucketAlreadyExists' || e.name === 'BucketAlreadyOwnedByYou') {
            console.log('Bucket "datalake" already exists.');
        } else {
            console.error('Error creating bucket:', e.message);
        }
    }

    const dataDir = './data';
    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv') || f.endsWith('.parquet'));
    for (const f of files) {
        const body = fs.readFileSync(path.join(dataDir, f));
        await client.send(new PutObjectCommand({ Bucket: 'datalake', Key: f, Body: body }));
        console.log(`Uploaded ${f}`);
    }
}
run();
