const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const src = 'data/extensions/v1.4.4/windows_amd64/orc.duckdb_extension.gz';
const dest = 'data/extensions/v1.4.4/windows_amd64/orc.duckdb_extension';

try {
    const input = fs.readFileSync(src);
    const decompressed = zlib.gunzipSync(input);
    fs.writeFileSync(dest, decompressed);
    console.log('✅ Successfully decompressed ORC extension');
} catch (e) {
    console.error('❌ Decompression failed:', e.message);
}
