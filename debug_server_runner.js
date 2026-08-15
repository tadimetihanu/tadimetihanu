const { spawn } = require('child_process');
const fs = require('fs');

const log = fs.createWriteStream('debug_server.log');
const child = spawn('node', ['src/server.js']);

child.stdout.on('data', (data) => {
    log.write('[STDOUT] ' + data);
});

child.stderr.on('data', (data) => {
    log.write('[STDERR] ' + data);
});

child.on('close', (code) => {
    log.write('[EXIT] Code: ' + code);
    log.end();
});
