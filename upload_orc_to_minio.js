const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const s3 = new S3Client({
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    forcePathStyle: true
});

async function uploadFile(bucket, key, filePath) {
    if (!fs.existsSync(filePath)) {
        console.error(`Source file not found at: ${filePath}`);
        return;
    }

    console.log(`🚀 Uploading ${key} (${(fs.statSync(filePath).size / (1024*1024)).toFixed(2)} MB) to MinIO...`);
    try {
        const stream = fs.createReadStream(filePath);
        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: stream
        }));
        console.log(`✅ Upload successful for ${key}!`);
    } catch (e) {
        console.error(`❌ Upload failed for ${key}:`, e.message);
    }
}

async function run() {
    const bucket = 'datalake';
    // Use the files from the source D:\minio_data\datalake
    await uploadFile(bucket, 'performance_1m.orc', 'D:\\minio_data\\datalake\\performance_1m.orc');
    await uploadFile(bucket, 'performance_100m.orc', 'D:\\minio_data\\datalake\\performance_100m.orc');
    console.log('🎉 All uploads completed!');
}

run();
