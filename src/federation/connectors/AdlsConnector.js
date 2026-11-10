const fs = require('fs');
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');
const { BaseConnector } = require('./BaseConnector');

class AdlsConnector extends BaseConnector {
    constructor(catalogConfig = {}) {
        super({ ...catalogConfig, source_type: catalogConfig.source_type || 'adls' });
        this.blobClient = null;
    }

    getLocalBaseDir() {
        if (this.config.localBaseDir && fs.existsSync(this.config.localBaseDir)) {
            return this.config.localBaseDir;
        }
        const defaultDir = path.join(process.cwd(), 'data', 'federation_sources', this.catalogName);
        if (fs.existsSync(defaultDir)) return defaultDir;
        return null;
    }

    async connect() {
        const start = Date.now();
        if (this.config.simulateOffline || this.config.failConnection) {
            throw new Error(`[AdlsConnector:${this.catalogName}] Azure ADLS Gen2 endpoint unreachable or SAS/AccountKey invalid`);
        }

        const localDir = this.getLocalBaseDir();
        if (localDir) {
            this.connected = true;
            this.lastConnectedAt = new Date().toISOString();
            return { connected: true, mode: 'local_lakehouse', latencyMs: Date.now() - start };
        }

        const connStr = this.config.connectionString || this.config.connection_string || '';
        const container = this.config.container || this.config.bucket || '';
        if (!connStr && !localDir) {
            throw new Error(`[AdlsConnector:${this.catalogName}] Missing Azure ADLS Gen2 connection string or account credentials`);
        }
        if (!container && !localDir) {
            throw new Error(`[AdlsConnector:${this.catalogName}] Missing Azure ADLS Gen2 container/filesystem name`);
        }

        if (connStr) {
            this.blobClient = BlobServiceClient.fromConnectionString(connStr);
        }
        this.connected = true;
        this.lastConnectedAt = new Date().toISOString();
        return { connected: true, mode: 'remote_adls', latencyMs: Date.now() - start };
    }

    async disconnect() {
        this.blobClient = null;
        this.connected = false;
        return { connected: false };
    }

    async testConnection() {
        const start = Date.now();
        await this.connect();
        const localDir = this.getLocalBaseDir();
        if (!localDir && this.blobClient && (this.config.container || this.config.bucket) && !this.config.skipRemotePing) {
            try {
                const containerClient = this.blobClient.getContainerClient(this.config.container || this.config.bucket);
                const iter = containerClient.listBlobsFlat().byPage({ maxPageSize: 1 });
                await Promise.race([
                    iter.next(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('ADLS Gen2 connection timeout (5000ms)')), 5000))
                ]);
            } catch (err) {
                throw new Error(`[AdlsConnector:${this.catalogName}] Azure ADLS Gen2 test failed: ${err.message}`);
            }
        }
        return {
            success: true,
            status: 'connected',
            sourceType: this.sourceType,
            catalogName: this.catalogName,
            latencyMs: Math.max(1, Date.now() - start),
            testedAt: new Date().toISOString()
        };
    }

    async listSchemas() {
        await this.connect();
        const localDir = this.getLocalBaseDir();
        if (localDir) {
            const entries = fs.readdirSync(localDir, { withFileTypes: true });
            const schemas = entries.filter(e => e.isDirectory()).map(e => e.name);
            return schemas.length > 0 ? schemas : ['sales'];
        }
        return Array.isArray(this.config.schemas) && this.config.schemas.length > 0
            ? this.config.schemas
            : ['sales', 'finance', 'default'];
    }

    async listTables(schemaName = 'sales') {
        await this.connect();
        const localDir = this.getLocalBaseDir();
        if (localDir) {
            const schemaDir = path.join(localDir, schemaName);
            const targetDir = fs.existsSync(schemaDir) ? schemaDir : localDir;
            const entries = fs.readdirSync(targetDir, { withFileTypes: true });
            const tables = [];
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.endsWith('.iceberg')) {
                    const dataDir = path.join(targetDir, entry.name, 'data');
                    let sizeBytes = 0;
                    if (fs.existsSync(dataDir)) {
                        for (const f of fs.readdirSync(dataDir)) {
                            sizeBytes += fs.statSync(path.join(dataDir, f)).size;
                        }
                    }
                    tables.push({
                        schema_name: schemaName,
                        table_name: entry.name.replace(/\.iceberg$/i, ''),
                        format: 'iceberg',
                        physical_location: path.join(targetDir, entry.name).replace(/\\/g, '/'),
                        size_bytes: sizeBytes
                    });
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase().replace(/^\./, '');
                    if (['parquet', 'csv', 'json', 'jsonl'].includes(ext)) {
                        const st = fs.statSync(path.join(targetDir, entry.name));
                        tables.push({
                            schema_name: schemaName,
                            table_name: path.basename(entry.name, path.extname(entry.name)),
                            format: ext,
                            physical_location: path.join(targetDir, entry.name).replace(/\\/g, '/'),
                            size_bytes: st.size
                        });
                    }
                }
            }
            return tables;
        }
        return [];
    }

    async getTableSchema(schemaName, tableName) {
        const tables = await this.listTables(schemaName);
        const match = tables.find(t => t.table_name.toLowerCase() === String(tableName).toLowerCase());
        if (!match) {
            throw new Error(`Table ${this.catalogName}.${schemaName}.${tableName} not found in Azure ADLS Gen2 catalog`);
        }
        return match;
    }

    async executeScan(scanSpec = {}) {
        if (this.config.simulateOffline || this.config.failScan) {
            throw new Error(`Source execution failure on catalog '${this.catalogName}' (Azure ADLS Gen2): Storage account unreachable during scan of ${scanSpec.schemaName}.${scanSpec.tableName}`);
        }
        const { schemaName, tableName, columns = ['*'], predicates = [], tableMeta = {} } = scanSpec;
        const physicalPath = (tableMeta.physical_location || '').replace(/\\/g, '/');
        const format = (tableMeta.format || 'parquet').toLowerCase();

        if (!physicalPath) {
            throw new Error(`Missing physical ADLS path for ${this.catalogName}.${schemaName}.${tableName}`);
        }

        let readerExpr;
        const safePath = physicalPath.replace(/'/g, "''");
        if (format === 'iceberg' || physicalPath.endsWith('.iceberg')) {
            const dataDir = path.join(physicalPath, 'data');
            if (fs.existsSync(dataDir)) {
                const parquetGlob = path.join(dataDir, '*.parquet').replace(/\\/g, '/').replace(/'/g, "''");
                readerExpr = `read_parquet('${parquetGlob}')`;
            } else {
                readerExpr = `iceberg_scan('${safePath}')`;
            }
        } else if (format === 'csv') {
            readerExpr = `read_csv_auto('${safePath}', header=true)`;
        } else if (format === 'json' || format === 'jsonl') {
            readerExpr = `read_json_auto('${safePath}')`;
        } else {
            readerExpr = `read_parquet('${safePath}')`;
        }

        const proj = this.buildProjectionList(columns, tableMeta.columns || []);
        const whereClause = this.buildSafeWhereClause(predicates);
        const subQuery = `(SELECT ${proj} FROM ${readerExpr} ${whereClause})`.trim();

        return {
            catalogName: this.catalogName,
            sourceType: this.sourceType,
            schemaName,
            tableName,
            format,
            duckdbExpression: subQuery,
            rawReaderExpression: readerExpr,
            pushedPredicates: predicates,
            pushedProjections: proj === '*' ? ['*'] : columns,
            costCategory: 'CLOUD_OBJECT_BYTES_SCANNED',
            physicalSizeBytes: Number(tableMeta.size_bytes || 0)
        };
    }

    getCapabilities() {
        return {
            sourceType: 'adls',
            providerName: 'Azure ADLS Gen2',
            supportsPredicatePushdown: true,
            supportsProjectionPushdown: true,
            supportsLimitPushdown: true,
            supportsAggregationPushdown: false,
            supportsJoinPushdown: false,
            supportsDynamicFiltering: true,
            supportsIceberg: true,
            supportedFormats: ['parquet', 'iceberg', 'csv', 'json'],
            isRelational: false,
            isObjectStorage: true,
            costModel: 'CLOUD_OBJECT_SCAN_USD_PER_TIB',
            rateUsdPerTib: 5.0
        };
    }
}

module.exports = { AdlsConnector };

