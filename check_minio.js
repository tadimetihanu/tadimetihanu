const { S3Client, ListBucketsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({
    endpoint: 'http://127.0.0.1:9000',
    region: 'us-east-1',
    credentials: {
        accessKeyId: 'minioadmin',
        secretAccessKey: 'minioadmin'
    },
    forcePathStyle: true
});

async function run() {
    try {
        const { Buckets } = await s3Client.send(new ListBucketsCommand({}));
        console.log('Buckets:', Buckets.map(b => b.Name).join(', '));
        
        console.log('\nObjects in "datalake":');
        const data = await s3Client.send(new ListObjectsV2Command({ Bucket: 'datalake' }));
        if (data.Contents) {
            data.Contents.forEach(obj => console.log(obj.Key));
        } else {
            console.log('No objects found (or bucket empty).');
        }
    } catch (e) {
        console.error(e);
    }
}
run();
