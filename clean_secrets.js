const Database = require('better-sqlite3');
const db = new Database('data/metadata.db');
try {
    db.prepare("DELETE FROM duckdb_secrets").run();
    console.log('Cleared duckdb_secrets');
} catch (e) {
    console.log('duckdb_secrets did not exist or could not be cleared');
}
db.close();
