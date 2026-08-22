const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const db = new Database('./data/metadata.db');
const u = db.prepare("SELECT * FROM users WHERE role = 'admin'").get();
const t = db.prepare("SELECT * FROM targets WHERE provider_type = 'gdrive'").get();
const token = jwt.sign({ user_id: u.user_id, email: u.email, role: u.role }, 'super_secret_enterprise_jwt_key_2026');

async function test() {
    console.log('Testing live HTTP query against http://localhost:4000 ...');
    
    // 1. Schema
    const schemaRes = await fetch(`http://localhost:4000/api/schema/${t.target_id}?fileName=quarterly_sales_2026.parquet`, {
        headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json());
    console.log('Schema Result:', schemaRes.success ? '✅ Success' : '❌ Failed', schemaRes);

    // 2. Query
    const queryRes = await fetch(`http://localhost:4000/api/query/${t.target_id}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            sql: "SELECT * FROM read_parquet('gdrive://root/quarterly_sales_2026.parquet') LIMIT 3"
        })
    }).then(r => r.json());

    console.log('Query Result:', queryRes.success ? '✅ Success' : '❌ Failed');
    console.log(queryRes);
}

test();
