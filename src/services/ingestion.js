const ftp = require("basic-ftp");
const Client = require("ssh2-sftp-client");
const storage = require("../drivers/storage");
const path = require("path");
const { PassThrough } = require("stream");

async function ingestFile(sourceConfig, targetId, targetFolder) {
    const { type, host, port, user, password, sourcePath } = sourceConfig;
    const filename = path.basename(sourcePath);
    // Sanitize targetFolder
    const folder = targetFolder ? (targetFolder.endsWith('/') ? targetFolder : targetFolder + '/') : '';
    const destinationKey = folder + filename;

    console.log(`[Ingestion] Starting ingestion of ${sourcePath} from ${type}://${host} to Target ${targetId} at ${destinationKey}`);

    if (type === 'ftp') {
        return await ingestFromFTP(host, port, user, password, sourcePath, targetId, destinationKey);
    } else if (type === 'sftp') {
        return await ingestFromSFTP(host, port, user, password, sourcePath, targetId, destinationKey);
    } else {
        throw new Error(`Unsupported ingestion source type: ${type}`);
    }
}

async function ingestFromFTP(host, port, user, password, sourcePath, targetId, destinationKey) {
    const client = new ftp.Client();
    try {
        await client.access({
            host: host,
            port: port ? parseInt(port) : 21,
            user: user,
            password: password,
            secure: false
        });

        const passThrough = new PassThrough();
        
        // Start upload and download concurrently
        const uploadPromise = storage.uploadStream(targetId, destinationKey, passThrough, 'application/octet-stream');
        
        await client.downloadTo(passThrough, sourcePath);
        
        const result = await uploadPromise;
        return result;
    } finally {
        client.close();
    }
}

async function ingestFromSFTP(host, port, user, password, sourcePath, targetId, destinationKey) {
    const sftp = new Client();
    try {
        await sftp.connect({
            host: host,
            port: port ? parseInt(port) : 22,
            username: user,
            password: password
        });

        const passThrough = new PassThrough();
        
        const uploadPromise = storage.uploadStream(targetId, destinationKey, passThrough, 'application/octet-stream');
        
        // sftp.get() can write to a stream
        await sftp.get(sourcePath, passThrough);
        
        const result = await uploadPromise;
        return result;
    } finally {
        await sftp.end();
    }
}

module.exports = {
    ingestFile
};
