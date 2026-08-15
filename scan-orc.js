const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

console.log('🐘 CloudObjectIQ ORC Discovery Engine starting...');

const commonPaths = ['/data', '/root', '/tmp', '/mnt', '/home'];
const foundFiles = [];

function scanDir(dir) {
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            try {
                const stats = fs.statSync(fullPath);
                if (stats.isDirectory()) {
                    // Avoid scanning system critical folders to save time
                    if (!fullPath.includes('/proc') && !fullPath.includes('/sys') && !fullPath.includes('/dev')) {
                        scanDir(fullPath);
                    }
                } else if (file.toLowerCase().endsWith('.orc')) {
                    console.log(`✨ Found ORC: ${fullPath}`);
                    foundFiles.push(fullPath);
                }
            } catch (e) {}
        }
    } catch (e) {}
}

console.log('🔍 Scanning common data paths for ORC files...');
commonPaths.forEach(scanDir);

console.log(`💾 Registering ${foundFiles.length} files to dashboard...`);

const insert = db.prepare('INSERT INTO saved_queries (id, user_id, name, sql, created_at) VALUES (?, ?, ?, ?, ?)');

foundFiles.forEach(f => {
    const fileName = path.basename(f);
    const sql = `-- AUTO-DISCOVERED ORC\nSELECT * FROM read_orc('${f}') LIMIT 100;`;
    try {
        insert.run(
            require('crypto').randomUUID(),
            1, // Default Admin User
            `🔎 Data: ${fileName}`,
            sql,
            new Date().toISOString()
        );
    } catch (e) {
        // Likely duplicate, skip
    }
});

console.log('✅ Discovery Complete! Refresh your dashboard at http://10.2.152.213:3001 to see your new datasets.');
