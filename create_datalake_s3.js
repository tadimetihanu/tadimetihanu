const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const s3Client = new S3Client({
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:9000',
    forcePathStyle: true,
    credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
        secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
    }
});

async function ensureBucket() {
    const bucketName = 'datalake';
    try {
        const command = new CreateBucketCommand({ Bucket: bucketName });
        await s3Client.send(command);
        console.log(`Bucket '${bucketName}' created successfully.`);
    } catch (err) {
        if (err.name === 'BucketAlreadyExists' || err.name === 'BucketAlreadyOwnedByYou') {
            console.log(`Bucket '${bucketName}' already exists.`);
        } else {
            console.error('Error creating bucket:', err);
        }
    }
}

ensureBucket();
