const Database = require('better-sqlite3');
const db = new Database('data/metadata.db');

// Fix for inseekdata container -> use inseeksadls account
db.prepare(`
    UPDATE targets 
    SET endpoint = REPLACE(endpoint, 'AccountName=inseekdata', 'AccountName=inseeksadls')
    WHERE bucket = 'inseekdata'
`).run();

// Fix for datainseektech container -> use datainseek account
db.prepare(`
    UPDATE targets 
    SET endpoint = REPLACE(endpoint, 'AccountName=inseekdata', 'AccountName=datainseek')
    WHERE bucket = 'datainseektech'
`).run();

// Ensure all adls/azure targets have correct suffixes (engine.js strips dfs, but better to be consistent)
db.prepare(`
    UPDATE targets 
    SET endpoint = REPLACE(endpoint, 'EndpointSuffix=core.windows.net', 'EndpointSuffix=dfs.core.windows.net')
    WHERE provider_type IN ('adls', 'azure') AND endpoint NOT LIKE '%EndpointSuffix=dfs.core.windows.net%'
`).run();

console.log('Database configuration sanitized.');
const rows = db.prepare("SELECT target_id, target_name, bucket, endpoint FROM targets").all();
console.log(JSON.stringify(rows, null, 2));
db.close();
