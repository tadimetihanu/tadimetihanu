const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

async function test() {
    const s3 = new S3Client({
        endpoint: 'http://192.168.0.197:9000',
        region: 'us-east-1',
        credentials: { 
            accessKeyId: 'minioadmin', 
            secretAccessKey: 'minioadmin' 
        },
        forcePathStyle: true,
    });

    try {
        const cmd = new ListObjectsV2Command({ Bucket: 'datainseek1' });
        const res = await s3.send(cmd);
        console.log('SUCCESS! Found:', res.Contents?.length, 'items');
    } catch (err) {
        console.error('FAILED! Error Code:', err.code, 'Message:', err.message);
    }
}

test();
