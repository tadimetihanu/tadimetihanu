const Database = require('better-sqlite3');
const db = new Database('data/metadata.db');

// Multi-replace to catch all variations
const result = db.prepare(`
    UPDATE targets 
    SET endpoint = REPLACE(REPLACE(endpoint, 'inseeksadls', 'inseekdata'), 'datainseek', 'inseekdata'),
        bucket = REPLACE(bucket, 'inseeksadls', 'inseekdata')
    WHERE endpoint LIKE '%inseeksadls%' 
       OR endpoint LIKE '%datainseek%'
       OR bucket LIKE '%inseeksadls%'
`).run();

console.log(`Global fix applied: ${result.changes} rows updated`);
db.close();
