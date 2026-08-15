const { S3Client, CreateBucketCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');

async function init() {
    const s3 = new S3Client({
        endpoint: 'http://localhost:9000',
        region: 'us-east-1',
        credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
        forcePathStyle: true
    });

    const bucket = 'datalake';

    try {
        console.log(`📡 Creating bucket '${bucket}'...`);
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        console.log('✅ Bucket created!');
    } catch (e) {
        if (e.name === 'BucketAlreadyOwnedByYou' || e.name === 'BucketAlreadyExists') {
            console.log('✅ Bucket already exists.');
        } else {
            console.error('❌ CreateBucket failed:', e.message);
            return;
        }
    }

    const files = [
        { name: 'iris.parquet', path: './data/datalake/iris.parquet' },
        { name: 'census_data.parquet', path: './data/datalake/census_data.parquet' }
    ];

    for (const f of files) {
        if (!fs.existsSync(f.path)) continue;
        console.log(`📡 Uploading ${f.name}...`);
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: f.name, Body: fs.readFileSync(f.path) }));
        console.log(`✅ ${f.name} uploaded!`);
    }

    console.log('📡 Verifying list...');
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    console.log('✅ Files found:', (res.Contents || []).map(o => o.Key));
    process.exit(0);
}
init().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
