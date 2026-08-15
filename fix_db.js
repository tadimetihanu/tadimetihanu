const Database = require('better-sqlite3');
const db = new Database('data/metadata.db');

// Fix inseeksadls -> inseekdata
const result1 = db.prepare("UPDATE targets SET endpoint = REPLACE(endpoint, 'inseeksadls', 'inseekdata') WHERE endpoint LIKE '%inseeksadls%'").run();
console.log(`Updated inseeksadls: ${result1.changes} rows`);

// Fix datainseek -> inseekdata (if applicable, testing based on user's previous feedback)
// Actually, I'll only fix what I'm sure of from the logs.
// The logs show: [PrefixGen] Target: ADLS Primary Lake, Type: adls, Prefix: az://datainseektech/
// So 'datainseektech' is the container/bucket.
// But the account name in endpoint is 'datainseek'.

// Let's also clear secrets
db.prepare("DELETE FROM duckdb_secrets").run();
console.log('Cleared duckdb_secrets');

db.close();
