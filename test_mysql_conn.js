// test_mysql_conn.js
const { runQuery } = require('./src/query/engine');

async function test() {
    console.log("--- MySQL Diagnostic Test ---");
    const host = "cloudobject1.mysql.database.azure.com";
    const user = "sshuser"; // or "sshuser@cloudobject1"
    const pass = "SolixSbds4701%%";
    const port = 3306;
    const db = "mysql"; // default testing db

    // Try both user formats
    const userFormats = [user, `${user}@cloudobject1` ];

    for (const u of userFormats) {
        console.log(`\n[Test] Attempting connection as: ${u}`);
        try {
            // Using DuckDB MySQL extension syntax
            // ATTACH 'host=... user=... password=... port=... database=...' AS my_db (TYPE MYSQL);
            const sql = `
                INSTALL mysql; 
                LOAD mysql;
                ATTACH 'host=${host} user=${u} password=${pass} port=${port} database=${db}' AS test_cloud (TYPE MYSQL);
                SELECT 1 as connected;
                DETACH test_cloud;
            `;
            const results = await runQuery(sql);
            if (results && results.length > 0) {
                console.log(`✅ SUCCESS! Successfully connected to Azure MySQL as ${u}`);
                process.exit(0);
            }
        } catch (err) {
            console.error(`❌ FAILED for ${u}:`, err.message);
        }
    }
    
    console.log("\n[Summary] All connection attempts failed. This is usually due to the Azure Firewall blocking your current Server IP.");
    process.exit(1);
}

test();
