const { S3Client, PutObjectCommand, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const https = require('https');

const s3 = new S3Client({
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    forcePathStyle: true
});

const fileUrl = 'https://raw.githubusercontent.com/apache/orc/main/examples/orc-file-11-format.orc';
const filePath = 'orc-file-11-format.orc';
const bucket = 'datalake';

async function run() {
    try {
        // Download the file
        console.log(`Downloading ${fileUrl}...`);
        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(filePath);
            https.get(fileUrl, (response) => {
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
            }).on('error', (err) => {
                fs.unlink(filePath, () => reject(err));
            });
        });
        console.log(`Downloaded ${filePath}.`);

        // Create bucket if not exists
        try {
            await s3.send(new HeadBucketCommand({ Bucket: bucket }));
        } catch (e) {
            console.log(`Bucket ${bucket} does not exist. Creating...`);
            await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        }

        // Upload to MinIO
        console.log(`Uploading ${filePath} to MinIO bucket '${bucket}'...`);
        const fileContent = fs.readFileSync(filePath);
        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: filePath,
            Body: fileContent
        }));
        console.log(`Upload successful!`);
    } catch (e) {
        console.error(e);
    }
}

run();
