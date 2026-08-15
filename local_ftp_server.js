const FtpSrv = require('ftp-srv');
const path = require('path');

const port = 2121;
const ftpServer = new FtpSrv({
    url: "ftp://127.0.0.1:" + port,
    anonymous: true,
    pasv_url: "127.0.0.1",
    // We disable PASV min/max port so it just picks random free ports locally
});

ftpServer.on('login', ({ connection, username, password }, resolve, reject) => {
    console.log(`[FTP] Login attempt: username=${username}, password=${password}`);
    
    // We allow anonymous access or any username for testing
    // Serve the 'ftp_data' directory relative to this script
    const rootPath = path.join(__dirname, 'ftp_data');
    
    return resolve({ root: rootPath });
});

ftpServer.listen().then(() => {
    console.log(`🚀 Local FTP Server running on ftp://127.0.0.1:${port}`);
    console.log(`Serving files from: ${path.join(__dirname, 'ftp_data')}`);
    console.log(`You can use anonymous login or any username/password to test ingestion.`);
});
