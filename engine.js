const { runQuery } = require('../query/engine');
const mssql = require('mssql');
const oracledb = require('oracledb');


const _dbConfigs = {};

function setDbConfig(name, config) {
    _dbConfigs[name] = config;
}

async function connectDb(type, config) {
    // For DuckDB, we use ATTACH
    // type can be 'postgres' or 'mysql'
    const { host, port, user, password, database, name } = config;
    let connStr = '';
    
    if (type === 'postgres') {
        connStr = `dbname=${database} user=${user} password=${password} host=${host} port=${port || 5432}`;
        await runQuery(`ATTACH '${connStr}' AS ${name} (TYPE POSTGRES);`);
    } else if (type === 'mysql') {
        connStr = `host=${host} user=${user} password=${password} port=${port || 3306} database=${database}`;
        await runQuery(`ATTACH '${connStr}' AS ${name} (TYPE MYSQL);`);
    } else if (type === 'sqlserver') {
        // Generic SQL Server query bridge (DuckDB doesn't have native extension in all builds)
        const pool = await mssql.connect({
            server: host,
            port: parseInt(port) || 1433,
            user,
            password,
            database,
            options: { encrypt: false, trustServerCertificate: true }
        });
        _dbConfigs[name] = { pool, type: 'sqlserver', ...config };
        return { success: true, name };
    } else if (type === 'oracle') {
        const conn = await oracledb.getConnection({
            user, password, connectString: `${host}:${port || 1521}/${database}`
        });
        _dbConfigs[name] = { conn, type: 'oracle', ...config };
        return { success: true, name };
    } else {
        throw new Error(`Unsupported database type: ${type}`);
    }
    
    _dbConfigs[name] = { type, ...config };
    return { success: true, name };
}

async function listTables(dbName) {
    const rows = await runQuery(`SHOW TABLES FROM ${dbName};`);
    return rows.map(r => r.name || r.table_name);
}

module.exports = {
    setDbConfig,
    connectDb,
    listTables,
    _dbConfigs
};
