const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const targetDir = path.join(__dirname, 'data');
if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir);

console.log('Generating Parquet datasets for HDFS...');

// Use DuckDB CLI to generate a parquet file
try {
    const sql = `
        COPY (
            SELECT 
                range as id,
                'user_' || (random() * 1000)::int as username,
                (random() * 5000)::decimal(10,2) as balance,
                CASE WHEN random() > 0.5 THEN 'ACTIVE' ELSE 'INACTIVE' END as status,
                now() - interval (random() * 365) day as joined_date
            FROM range(10000)
        ) TO '${path.join(targetDir, 'users_lake.parquet')}' (FORMAT PARQUET);
    `;
    
    // Check if duckdb cli is available, if not use a node-duckdb if exists, 
    // but usually user has duckdb installed or I can use my engine.js logic
    
    fs.writeFileSync('gen.sql', sql);
    console.log('Dataset SQL prepared.');
    
} catch (err) {
    console.error('Failed to generate parquet:', err);
}
