const Minio = require('minio');
require('dotenv').config();

const minioClient = new Minio.Client({
    endPoint: '127.0.0.1',
    port: 9000,
    useSSL: false,
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
});

async function ensureBucket() {
    const bucketName = 'datalake';
    try {
        const exists = await minioClient.bucketExists(bucketName);
        if (exists) {
            console.log(`Bucket '${bucketName}' already exists.`);
        } else {
            await minioClient.makeBucket(bucketName);
            console.log(`Bucket '${bucketName}' created successfully.`);
        }
    } catch (err) {
        console.error('Error creating bucket:', err);
    }
}

ensureBucket();
