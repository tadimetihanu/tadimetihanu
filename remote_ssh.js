const { Client } = require('ssh2');

const usernames = ['sshuser', 'administrator', 'root'];
const password = 'SolixSbds4701%%';
const host = '10.1.2.69';

async function tryConnect(username) {
    return new Promise((resolve) => {
        const conn = new Client();
        conn.on('ready', () => {
            console.log(`✅ Success with username: ${username}`);
            conn.exec('D: && cd D:\\Sparkup && dir', (err, stream) => {
                if (err) { resolve({ success: false, username }); return; }
                let output = '';
                stream.on('close', () => {
                    conn.end();
                    resolve({ success: true, username, output });
                }).on('data', (data) => {
                    output += data;
                    console.log(`[${username}] STDOUT: ${data}`);
                }).stderr.on('data', (data) => {
                    console.error(`[${username}] STDERR: ${data}`);
                });
            });
        }).on('error', (err) => {
            console.log(`❌ Failed with username: ${username} - ${err.message}`);
            resolve({ success: false, username, error: err.message });
        }).connect({
            host,
            port: 22,
            username,
            password,
            readyTimeout: 5000
        });
    });
}

(async () => {
    for (const user of usernames) {
        console.log(`⏳ Trying SSH user: ${user}...`);
        const result = await tryConnect(user);
        if (result.success) {
            console.log('🏁 Remote Directory Content:\n', result.output);
            break;
        }
    }
})();
