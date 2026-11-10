const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const duckdb = require('duckdb');
const db = require('../db');
const {
    encryptConnectionConfig,
    decryptConnectionConfig,
    redactConnectionConfig
} = require('./crypto');
const { createConnector } = require('./connectors');
const { ensureFederationSampleData } = require('./sampleCatalogs');

const _connectorPool = new Map();
const _metadataCache = new Map();
let _registryInitialized = false;

/**
 * Records an immutable audit event in `federation_audit_logs`.
 */
async function logFederationAudit({
    tenantId = 'default_tenant',
    userId = 'system',
    action,
    resourceType = 'catalog',
    resourceId = '',
    catalogName = '',
    status = 'success',
    details = {},
    ipAddress = '127.0.0.1'
}) {
    try {
        const auditId = crypto.randomUUID();
        const safeDetails = redactConnectionConfig(details);
        await db.run(
            `INSERT INTO federation_audit_logs
             (audit_id, tenant_id, user_id, action, resource_type, resource_id, catalog_name, status, details_json, ip_address)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                auditId,
                tenantId || 'default_tenant',
                userId || 'system',
                action,
                resourceType,
                resourceId,
                catalogName,
                status,
                JSON.stringify(safeDetails),
                ipAddress
            ]
        );
    } catch (err) {
        console.warn('[Federation Audit Log Notice]:', err.message);
    }
}

/**
 * Inspects column names, types, and row count for a physical file using an ephemeral DuckDB instance.
 */
async function inspectPhysicalTableColumns(physicalLocation, format = 'parquet') {
    const duck = new duckdb.Database(':memory:');
    const allAsync = (sql) =>
        new Promise((resolve, reject) => {
            duck.all(sql, (err, rows) => (err ? reject(err) : resolve(rows || [])));
        });

    try {
        const safePath = String(physicalLocation).replace(/\\/g, '/').replace(/'/g, "''");
        let readerExpr;
        if (format === 'iceberg' || safePath.endsWith('.iceberg')) {
            const dataDir = path.join(String(physicalLocation), 'data').replace(/\\/g, '/');
            if (fs.existsSync(dataDir)) {
                readerExpr = `read_parquet('${dataDir.replace(/'/g, "''")}/*.parquet')`;
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

        const descRows = await allAsync(`DESCRIBE SELECT * FROM ${readerExpr} LIMIT 1`);
        const countRows = await allAsync(`SELECT COUNT(*) AS cnt FROM ${readerExpr}`);
        const rowCount = Number(countRows[0]?.cnt || 0);
        const columns = descRows.map((r, idx) => ({
            column_name: r.column_name,
            data_type: r.column_type,
            ordinal_position: idx + 1,
            is_nullable: r.null === 'NO' ? 0 : 1
        }));
        return { columns, rowCount };
    } finally {
        await new Promise((r) => duck.close(() => r()));
    }
}

/**
 * Synchronizes schemas, tables, and column metadata for a catalog into SQLite/PostgreSQL.
 */
async function syncCatalogMetadata(catalogRow, connector) {
    const catalogId = catalogRow.catalog_id;
    const tenantId = catalogRow.tenant_id || 'default_tenant';
    const schemas = await connector.listSchemas();
    const schemaSummary = [];

    for (const schemaName of schemas) {
        let existingSchema = await db.get(
            `SELECT schema_id FROM federation_schemas WHERE catalog_id = ? AND lower(schema_name) = lower(?)`,
            [catalogId, schemaName]
        );
        const schemaId = existingSchema ? existingSchema.schema_id : crypto.randomUUID();
        if (!existingSchema) {
            await db.run(
                `INSERT INTO federation_schemas (schema_id, catalog_id, tenant_id, schema_name, metadata_json)
                 VALUES (?, ?, ?, ?, ?)`,
                [schemaId, catalogId, tenantId, schemaName, JSON.stringify({ syncedAt: new Date().toISOString() })]
            );
        }

        const tables = await connector.listTables(schemaName);
        const tableSummaryList = [];
        for (const tbl of tables) {
            let existingTbl = await db.get(
                `SELECT table_id FROM federation_tables WHERE catalog_id = ? AND lower(schema_name) = lower(?) AND lower(table_name) = lower(?)`,
                [catalogId, schemaName, tbl.table_name]
            );
            const tableId = existingTbl ? existingTbl.table_id : crypto.randomUUID();

            let columns = [];
            let rowCount = Number(tbl.row_count_estimate || 0);
            let physicalLocation = tbl.physical_location || '';

            try {
                if (['postgresql', 'mysql'].includes(connector.sourceType)) {
                    const detail = await connector.getTableSchema(schemaName, tbl.table_name);
                    columns = detail.columns || [];
                    rowCount = Number(detail.row_count_estimate || rowCount || 0);
                    physicalLocation = detail.physical_location || physicalLocation;
                } else if (physicalLocation && fs.existsSync(physicalLocation)) {
                    const inspected = await inspectPhysicalTableColumns(physicalLocation, tbl.format);
                    columns = inspected.columns;
                    rowCount = inspected.rowCount;
                }
            } catch (err) {
                console.warn(`[Federation Metadata Inspect Notice] ${catalogRow.catalog_name}.${schemaName}.${tbl.table_name}: ${err.message}`);
            }

            if (existingTbl) {
                await db.run(
                    `UPDATE federation_tables
                     SET physical_location = ?, format = ?, row_count_estimate = ?, size_bytes = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE table_id = ?`,
                    [physicalLocation, tbl.format || 'parquet', rowCount, Number(tbl.size_bytes || 0), tableId]
                );
            } else {
                await db.run(
                    `INSERT INTO federation_tables
                     (table_id, schema_id, catalog_id, tenant_id, schema_name, table_name, physical_location, format, row_count_estimate, size_bytes, metadata_json)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        tableId,
                        schemaId,
                        catalogId,
                        tenantId,
                        schemaName,
                        tbl.table_name,
                        physicalLocation,
                        tbl.format || 'parquet',
                        rowCount,
                        Number(tbl.size_bytes || 0),
                        JSON.stringify({ syncedAt: new Date().toISOString() })
                    ]
                );
            }

            if (columns.length > 0) {
                await db.run(`DELETE FROM federation_column_metadata WHERE table_id = ?`, [tableId]);
                for (const col of columns) {
                    await db.run(
                        `INSERT INTO federation_column_metadata
                         (column_id, table_id, catalog_id, tenant_id, column_name, data_type, ordinal_position, is_nullable)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            crypto.randomUUID(),
                            tableId,
                            catalogId,
                            tenantId,
                            col.column_name,
                            col.data_type,
                            col.ordinal_position || 0,
                            col.is_nullable !== undefined ? col.is_nullable : 1
                        ]
                    );
                }
            }

            tableSummaryList.push({
                table_id: tableId,
                table_name: tbl.table_name,
                format: tbl.format,
                row_count_estimate: rowCount,
                size_bytes: Number(tbl.size_bytes || 0),
                columns
            });
        }

        schemaSummary.push({
            schema_id: schemaId,
            schema_name: schemaName,
            tables: tableSummaryList
        });
    }

    await db.run(
        `UPDATE federation_catalogs
         SET schema_metadata_json = ?, last_successful_connection = CURRENT_TIMESTAMP, status = 'connected', updated_at = CURRENT_TIMESTAMP
         WHERE catalog_id = ?`,
        [JSON.stringify({ schemas: schemaSummary }), catalogId]
    );

    _metadataCache.delete(`${tenantId}:${catalogRow.catalog_name.toLowerCase()}`);
    return schemaSummary;
}

/**
 * Seeds the 5 default enterprise catalogs (Azure ADLS Gen2, AWS S3 + Iceberg, MinIO, PostgreSQL, MySQL)
 * if not yet present in `federation_catalogs`.
 */
async function initFederationCatalogs() {
    if (_registryInitialized) return;
    await db.initDatabase();
    const { baseDir } = await ensureFederationSampleData();

    const defaultCatalogs = [
        {
            catalog_id: 'cat-azure-sales-001',
            catalog_name: 'azure_sales',
            source_type: 'adls',
            auth_method: 'sas_token',
            tenant_id: 'default_tenant',
            config: {
                accountName: 'ciqenterpriseadls',
                container: 'sales-lakehouse',
                endpoint: 'https://ciqenterpriseadls.dfs.core.windows.net',
                sasToken: 'sv=2024-11-04&ss=bfqt&srt=sco&sp=rwdlacupyx&sig=EnterpriseAdlsSigRedacted',
                localBaseDir: path.join(baseDir, 'azure_sales')
            }
        },
        {
            catalog_id: 'cat-aws-customers-002',
            catalog_name: 'aws_customers',
            source_type: 's3',
            auth_method: 'iam_access_key',
            tenant_id: 'default_tenant',
            config: {
                bucket: 'ciq-enterprise-crm-s3',
                region: 'us-east-1',
                endpoint: 'https://s3.us-east-1.amazonaws.com',
                accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
                secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
                localBaseDir: path.join(baseDir, 'aws_customers')
            }
        },
        {
            catalog_id: 'cat-minio-products-003',
            catalog_name: 'minio_products',
            source_type: 'minio',
            auth_method: 'key_secret',
            tenant_id: 'default_tenant',
            config: {
                bucket: 'product-catalog-lake',
                region: 'us-east-1',
                endpoint: 'http://minio.cloudobjectiq.internal:9000',
                accessKeyId: 'minioadmin',
                secretAccessKey: 'minioadmin_secret_key',
                localBaseDir: path.join(baseDir, 'minio_products')
            }
        },
        {
            catalog_id: 'cat-pg-crm-004',
            catalog_name: 'pg_crm',
            source_type: 'postgresql',
            auth_method: 'username_password',
            tenant_id: 'default_tenant',
            config: {
                host: 'pg-crm.cloudobjectiq.internal',
                port: 5432,
                database: 'crm_production',
                user: 'federation_ro',
                password: 'pg_super_secret_password',
                sqliteBackingPath: path.join(baseDir, 'pg_crm', 'relational.sqlite')
            }
        },
        {
            catalog_id: 'cat-mysql-erp-005',
            catalog_name: 'mysql_erp',
            source_type: 'mysql',
            auth_method: 'username_password',
            tenant_id: 'default_tenant',
            config: {
                host: 'mysql-erp.cloudobjectiq.internal',
                port: 3306,
                database: 'inventory',
                user: 'erp_federation_ro',
                password: 'mysql_super_secret_password',
                sqliteBackingPath: path.join(baseDir, 'mysql_erp', 'relational.sqlite')
            }
        }
    ];

    for (const def of defaultCatalogs) {
        const existing = await db.get(
            `SELECT catalog_id FROM federation_catalogs WHERE tenant_id = ? AND lower(catalog_name) = lower(?)`,
            [def.tenant_id, def.catalog_name]
        );
        if (!existing) {
            const connId = `conn-${def.catalog_name}`;
            const encConfig = encryptConnectionConfig(def.config);
            await db.run(
                `INSERT INTO federation_connections
                 (connection_id, tenant_id, connection_name, source_type, connection_config_enc, auth_method, owner_id, status, last_tested_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', CURRENT_TIMESTAMP)`,
                [connId, def.tenant_id, `${def.catalog_name}_conn`, def.source_type, encConfig, def.auth_method, 'system']
            );

            const connector = createConnector({
                catalog_id: def.catalog_id,
                catalog_name: def.catalog_name,
                source_type: def.source_type,
                tenant_id: def.tenant_id,
                auth_method: def.auth_method,
                connectionConfig: def.config
            });
            const capabilities = connector.getCapabilities();

            await db.run(
                `INSERT INTO federation_catalogs
                 (catalog_id, catalog_name, source_type, connection_id, tenant_id, auth_method, status, capabilities_json, created_by, last_successful_connection)
                 VALUES (?, ?, ?, ?, ?, ?, 'connected', ?, 'system', CURRENT_TIMESTAMP)`,
                [
                    def.catalog_id,
                    def.catalog_name,
                    def.source_type,
                    connId,
                    def.tenant_id,
                    def.auth_method,
                    JSON.stringify(capabilities)
                ]
            );

            await syncCatalogMetadata(
                {
                    catalog_id: def.catalog_id,
                    catalog_name: def.catalog_name,
                    source_type: def.source_type,
                    tenant_id: def.tenant_id
                },
                connector
            );
        }
    }

    _registryInitialized = true;
}

/**
 * Retrieves or creates a pooled connector instance for a catalog.
 */
async function getConnectorForCatalog(catalogName, tenantId = 'default_tenant') {
    await initFederationCatalogs();
    const poolKey = `${tenantId}:${String(catalogName).toLowerCase()}`;
    const catRow = await db.get(
        `SELECT c.*, conn.connection_config_enc
         FROM federation_catalogs c
         LEFT JOIN federation_connections conn ON c.connection_id = conn.connection_id
         WHERE c.tenant_id = ? AND lower(c.catalog_name) = lower(?)`,
        [tenantId, catalogName]
    );
    if (!catRow) {
        throw new Error(`Catalog '${catalogName}' is not registered in tenant '${tenantId}'`);
    }

    const decryptedConfig = decryptConnectionConfig(catRow.connection_config_enc);
    const connector = createConnector({
        catalog_id: catRow.catalog_id,
        catalog_name: catRow.catalog_name,
        source_type: catRow.source_type,
        tenant_id: catRow.tenant_id,
        auth_method: catRow.auth_method,
        connectionConfig: decryptedConfig
    });
    _connectorPool.set(poolKey, connector);
    return { catalog: catRow, connector, decryptedConfig };
}

/**
 * Lists all catalogs for a tenant with redacted connection configs (NEVER exposes credentials).
 */
async function listCatalogs(tenantId = 'default_tenant') {
    await initFederationCatalogs();
    const rows = await db.all(
        `SELECT c.*, conn.connection_config_enc
         FROM federation_catalogs c
         LEFT JOIN federation_connections conn ON c.connection_id = conn.connection_id
         WHERE c.tenant_id = ?
         ORDER BY c.catalog_name ASC`,
        [tenantId]
    );

    const out = [];
    for (const r of rows) {
        let decrypted = {};
        try {
            decrypted = decryptConnectionConfig(r.connection_config_enc);
        } catch (_) {}
        let capabilities = {};
        try {
            capabilities = r.capabilities_json ? JSON.parse(r.capabilities_json) : {};
        } catch (_) {}
        let schemaMetadata = {};
        try {
            schemaMetadata = r.schema_metadata_json ? JSON.parse(r.schema_metadata_json) : {};
        } catch (_) {}

        out.push({
            catalog_id: r.catalog_id,
            catalog_name: r.catalog_name,
            source_type: r.source_type,
            connection_id: r.connection_id,
            tenant_id: r.tenant_id,
            auth_method: r.auth_method,
            status: r.status,
            created_at: r.created_at,
            last_successful_connection: r.last_successful_connection,
            connection_config: redactConnectionConfig(decrypted),
            capabilities,
            schema_metadata: schemaMetadata
        });
    }
    return out;
}

/**
 * Registers or updates a catalog and its encrypted connection configuration.
 */
async function registerCatalog({
    catalogName,
    sourceType,
    authMethod = 'key_secret',
    connectionConfig = {},
    tenantId = 'default_tenant',
    userId = 'admin',
    ipAddress = '127.0.0.1'
}) {
    await initFederationCatalogs();
    const cleanName = String(catalogName || '').trim().toLowerCase();
    if (!cleanName || !/^[a-z_][a-z0-9_]*$/.test(cleanName)) {
        throw new Error(`Invalid catalog_name '${catalogName}'. Must be a valid SQL identifier (letters, digits, underscores).`);
    }

    const normSource = String(sourceType || '').trim().toLowerCase();
    const connector = createConnector({
        catalog_name: cleanName,
        source_type: normSource,
        tenant_id: tenantId,
        auth_method: authMethod,
        connectionConfig
    });

    // Validate connection if requested or unless explicitly skipped
    let status = 'connected';
    let lastError = null;
    try {
        await connector.testConnection();
    } catch (connErr) {
        status = 'error';
        lastError = connErr.message;
        if (connectionConfig.requireValidConnection !== false) {
            await logFederationAudit({
                tenantId,
                userId,
                action: 'REGISTER_CATALOG_FAILED',
                resourceType: 'catalog',
                catalogName: cleanName,
                status: 'error',
                details: { sourceType: normSource, error: connErr.message },
                ipAddress
            });
            throw connErr;
        }
    }

    const existing = await db.get(
        `SELECT catalog_id, connection_id FROM federation_catalogs WHERE tenant_id = ? AND lower(catalog_name) = lower(?)`,
        [tenantId, cleanName]
    );

    const catalogId = existing ? existing.catalog_id : `cat-${cleanName}-${crypto.randomUUID().slice(0, 8)}`;
    const connectionId = existing ? existing.connection_id : `conn-${cleanName}-${crypto.randomUUID().slice(0, 8)}`;
    const encConfig = encryptConnectionConfig(connectionConfig);
    const capabilities = connector.getCapabilities();

    if (existing) {
        await db.run(
            `UPDATE federation_connections
             SET source_type = ?, connection_config_enc = ?, auth_method = ?, status = ?, last_error = ?, last_tested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE connection_id = ?`,
            [normSource, encConfig, authMethod, status, lastError, connectionId]
        );
        await db.run(
            `UPDATE federation_catalogs
             SET source_type = ?, auth_method = ?, status = ?, capabilities_json = ?, last_successful_connection = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE catalog_id = ?`,
            [normSource, authMethod, status, JSON.stringify(capabilities), catalogId]
        );
    } else {
        await db.run(
            `INSERT INTO federation_connections
             (connection_id, tenant_id, connection_name, source_type, connection_config_enc, auth_method, owner_id, status, last_error, last_tested_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [connectionId, tenantId, `${cleanName}_conn`, normSource, encConfig, authMethod, userId, status, lastError]
        );
        await db.run(
            `INSERT INTO federation_catalogs
             (catalog_id, catalog_name, source_type, connection_id, tenant_id, auth_method, status, capabilities_json, created_by, last_successful_connection)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [catalogId, cleanName, normSource, connectionId, tenantId, authMethod, status, JSON.stringify(capabilities), userId]
        );
    }

    if (status === 'connected') {
        await syncCatalogMetadata(
            { catalog_id: catalogId, catalog_name: cleanName, source_type: normSource, tenant_id: tenantId },
            connector
        );
    }

    _metadataCache.delete(`${tenantId}:${cleanName}`);

    await logFederationAudit({
        tenantId,
        userId,
        action: existing ? 'UPDATE_CATALOG' : 'REGISTER_CATALOG',
        resourceType: 'catalog',
        resourceId: catalogId,
        catalogName: cleanName,
        status,
        details: { sourceType: normSource, authMethod, connectionConfig },
        ipAddress
    });

    const catalogs = await listCatalogs(tenantId);
    return catalogs.find(c => c.catalog_id === catalogId);
}

/**
 * Resolves full metadata for `catalog.schema.table` (with caching & case-insensitivity).
 */
async function resolveTableMetadata(catalogName, schemaName, tableName, tenantId = 'default_tenant') {
    await initFederationCatalogs();
    const cacheKey = `${tenantId}:${catalogName.toLowerCase()}.${schemaName.toLowerCase()}.${tableName.toLowerCase()}`;
    if (_metadataCache.has(cacheKey)) {
        return _metadataCache.get(cacheKey);
    }

    const catRow = await db.get(
        `SELECT * FROM federation_catalogs WHERE tenant_id = ? AND lower(catalog_name) = lower(?)`,
        [tenantId, catalogName]
    );
    if (!catRow) {
        throw new Error(`Catalog '${catalogName}' does not exist in tenant '${tenantId}'`);
    }

    const tblRow = await db.get(
        `SELECT * FROM federation_tables
         WHERE catalog_id = ? AND lower(schema_name) = lower(?) AND lower(table_name) = lower(?)`,
        [catRow.catalog_id, schemaName, tableName]
    );
    if (!tblRow) {
        throw new Error(`Table '${catalogName}.${schemaName}.${tableName}' does not exist in catalog '${catalogName}'`);
    }

    const cols = await db.all(
        `SELECT column_name, data_type, ordinal_position, is_nullable
         FROM federation_column_metadata
         WHERE table_id = ?
         ORDER BY ordinal_position ASC`,
        [tblRow.table_id]
    );

    const resolved = {
        catalog_id: catRow.catalog_id,
        catalog_name: catRow.catalog_name,
        source_type: catRow.source_type,
        tenant_id: catRow.tenant_id,
        status: catRow.status,
        table_id: tblRow.table_id,
        schema_id: tblRow.schema_id,
        schema_name: tblRow.schema_name,
        table_name: tblRow.table_name,
        physical_location: tblRow.physical_location,
        format: tblRow.format,
        row_count_estimate: Number(tblRow.row_count_estimate || 0),
        size_bytes: Number(tblRow.size_bytes || 0),
        columns: cols || []
    };

    _metadataCache.set(cacheKey, resolved);
    return resolved;
}

/**
 * Enforces RBAC and tenant-level access control at catalog, schema, and table granularity.
 */
async function verifyTableAccess({ user, tenantId = 'default_tenant', catalogName, schemaName = '*', tableName = '*', action = 'select' }) {
    if (!user) {
        throw new Error('Authentication required for federated query access');
    }

    // Tenant isolation check: if user has an explicit tenant_id and it differs from requested tenantId, block access
    if (user.tenant_id && user.tenant_id !== tenantId) {
        await logFederationAudit({
            tenantId,
            userId: user.user_id,
            action: 'CROSS_TENANT_ACCESS_BLOCKED',
            resourceType: 'table',
            catalogName,
            status: 'denied',
            details: { userTenant: user.tenant_id, requestedTenant: tenantId, schemaName, tableName }
        });
        const err = new Error(`Tenant isolation violation: User from tenant '${user.tenant_id}' cannot access catalog '${catalogName}' in tenant '${tenantId}'`);
        err.statusCode = 403;
        throw err;
    }

    // Check explicit deny or allow policies in `federation_access_policies`
    const policies = await db.all(
        `SELECT * FROM federation_access_policies
         WHERE tenant_id = ?
           AND (subject_id = ? OR subject_id = ?)
           AND (lower(catalog_name) = lower(?) OR catalog_name = '*')`,
        [tenantId, user.user_id, user.role || 'viewer', catalogName]
    );

    if (policies && policies.length > 0) {
        // Find most specific policy matching schema/table
        const matching = policies.filter(
            p =>
                (p.schema_name === '*' || p.schema_name.toLowerCase() === schemaName.toLowerCase()) &&
                (p.table_name === '*' || p.table_name.toLowerCase() === tableName.toLowerCase())
        );

        if (matching.length > 0) {
            const denied = matching.some(p => (action === 'manage' ? Number(p.can_manage) === 0 : Number(p.can_select) === 0));
            if (denied) {
                await logFederationAudit({
                    tenantId,
                    userId: user.user_id,
                    action: 'RBAC_ACCESS_DENIED',
                    resourceType: 'table',
                    catalogName,
                    status: 'denied',
                    details: { schemaName, tableName, action }
                });
                const err = new Error(`Access denied by RBAC policy on ${catalogName}.${schemaName}.${tableName} for user '${user.email || user.user_id}'`);
                err.statusCode = 403;
                throw err;
            }
            return true;
        }
    }

    // Admins have full access unless an explicit deny policy exists above
    if (user.role === 'admin' || user.role === 'editor' || user.role === 'viewer' || user.role === 'user') {
        if (action === 'manage' && user.role !== 'admin') {
            const err = new Error('Admin role required to manage federation catalogs and policies');
            err.statusCode = 403;
            throw err;
        }
        return true;
    }

    const err = new Error(`Unauthorized role '${user.role}' for catalog '${catalogName}'`);
    err.statusCode = 403;
    throw err;
}

function clearMetadataCache() {
    _metadataCache.clear();
}

module.exports = {
    initFederationCatalogs,
    listCatalogs,
    registerCatalog,
    getConnectorForCatalog,
    resolveTableMetadata,
    syncCatalogMetadata,
    verifyTableAccess,
    logFederationAudit,
    clearMetadataCache
};

