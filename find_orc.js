const fs = require('fs');
const path = require('path');

function findOrc(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                if (file !== 'node_modules' && file !== '.git') {
                    findOrc(fullPath);
                }
            } else if (file === 'orc.duckdb_extension' && stat.size > 1000000) {
                console.log(`FOUND: ${fullPath} (Size: ${stat.size})`);
            }
        } catch (e) {}
    }
}

console.log('Searching for valid ORC extension...');
findOrc('C:\\Users\\user\\.gemini\\antigravity\\scratch');
console.log('Search complete.');
