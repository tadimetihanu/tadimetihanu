const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { listFiles } = require('../drivers/storage');

const KNOWN_EXTENSIONS = ['.parquet', '.iceberg', '.orc', '.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.delta'];

function normalizeIdentifier(raw) {
    if (!raw) return '';
    return String(raw)
        .trim()
        .replace(/^["'`\[]+|["'`\]]+$/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function stripKnownExtension(filename) {
    let base = String(filename || '').trim();
    for (const ext of KNOWN_EXTENSIONS) {
        if (base.toLowerCase().endsWith(ext)) {
            base = base.slice(0, -ext.length);
            break;
        }
    }
    return base;
}

function getStorageUriForTarget(target, filePath) {
    const cleanPath = String(filePath || '').replace(/^\/+/, '');
    if (/^(s3|az|abfss|r2|gdrive|http|https):\/\//i.test(cleanPath)) {
        return cleanPath;
    }
    const pType = String(target.provider_type || '').trim().toLowerCase();
    const bucket = String(target.bucket || 'datalake').trim().replace(/^\/+|\/+$/g, '');
    if (pType === 'azure' || pType === 'adls') {
        return `az://${bucket}/${cleanPath}`;
    }
    if (pType === 'r2' || pType === 'cloudflare') {
        return `r2://${bucket}/${cleanPath}`;
    }
    if (pType === 'gdrive' || pType === 'googledrive') {
        return `gdrive://${bucket || 'root'}/${cleanPath}`;
    }
    if (pType === 'local') {
        return cleanPath;
    }
    return `s3://${bucket}/${cleanPath}`;
}

function deriveLogicalCoordinates(target, filePath) {
    const catalogName = normalizeIdentifier(target.catalog_name || target.target_name || 'default_catalog');
    const defaultSchema = normalizeIdentifier(target.default_schema || 'default') || 'default';
    let relPath = String(filePath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');

    const basePrefix = String(target.base_prefix || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (basePrefix && relPath.toLowerCase().startsWith(basePrefix.toLowerCase() + '/')) {
        relPath = relPath.slice(basePrefix.length + 1);
    }

    const parts = relPath.split('/').filter(Boolean);
    let schemaName = defaultSchema;
    let rawTableSegment = parts[parts.length - 1] || 'dataset';

    if (parts.length >= 2) {
        schemaName = normalizeIdentifier(parts[0]) || defaultSchema;
        // If partitioned directory like crm/customers/part-0.parquet, use directory name as table name
        if (parts.length >= 3 && /^part[-_]|^\d+\.parquet$/i.test(parts[parts.length - 1])) {
            rawTableSegment = parts[parts.length - 2];
        } else {
            rawTableSegment = parts[parts.length - 1];
        }
    }

    const tableName = normalizeIdentifier(stripKnownExtension(rawTableSegment)) || 'dataset';
    const storageUri = getStorageUriForTarget(target, filePath);

    return {
        catalogName,
        schemaName,
        tableName,
        fullName: `${catalogName}.${schemaName}.${tableName}`,
        storageUri
    };
}

async function getAccessibleTargets(user = {}) {
    const userId = user.user_id || user.id || 'admin';
    const role = user.role || 'admin';
    const tenantId = user.tenant_id || 'default';

    if (role === 'admin' || userId === 'admin') {
        return await db.all(
            'SELECT * FROM targets WHERE COALESCE(tenant_id, ?) = ?',
            ['default', tenantId]
        );
    }

    return await db.all(
        `SELECT t.* FROM targets t
         JOIN permissions p ON t.target_id = p.target_id
         WHERE p.subject_id = ? AND p.subject_type = 'user' AND p.can_read = 1
           AND COALESCE(t.tenant_id, 'default') = ?`,
        [userId, tenantId]
    );
}

async function checkUserTargetReadAccess(user = {}, targetId) {
    const userId = user.user_id || user.id;
    const role = user.role || (userId === 'admin' ? 'admin' : 'user');
    const userTenant = user.tenant_id || 'default';

    const target = await db.get('SELECT * FROM targets WHERE target_id = ?', [targetId]);
    if (!target) {
        const err = new Error(`Storage target '${targetId}' not found.`);
        err.code = 'TARGET_NOT_FOUND';
        err.statusCode = 404;
        throw err;
    }

    const targetTenant = target.tenant_id || 'default';
    if (targetTenant !== userTenant) {
        const err = new Error(`Tenant security violation: User in tenant '${userTenant}' cannot access target '${target.target_name}' in tenant '${targetTenant}'.`);
        err.code = 'TENANT_ISOLATION_VIOLATION';
        err.statusCode = 403;
        throw err;
    }

    if (role === 'viewer') {
        const err = new Error('Permission denied: Viewers cannot execute federated SQL queries.');
        err.code = 'PERMISSION_DENIED';
        err.statusCode = 403;
        throw err;
    }

    if (role === 'admin' || userId === 'admin') {
        return target;
    }

    const perm = await db.get(
        `SELECT can_read FROM permissions WHERE subject_id = ? AND subject_type = 'user' AND target_id = ?`,
        [userId, targetId]
    );
    if (!perm || Number(perm.can_read) !== 1) {
        const err = new Error(`Permission denied: User does not have read access to storage source '${target.target_name}' (${target.catalog_name || target.target_id}).`);
        err.code = 'PERMISSION_DENIED';
        err.statusCode = 403;
        throw err;
    }

    return target;
}

async function registerCatalogEntry({
    targetId,
    catalogName,
    schemaName,
    tableName,
    filePath,
    fileSize = 0,
    rowCount = 0,
    format = 'parquet',
    schemaJson = null,
    tenantId = 'default',
    lastModified = null
}) {
    const target = await db.get('SELECT * FROM targets WHERE target_id = ?', [targetId]);
    if (!target) {
        throw new Error(`Target '${targetId}' not found`);
    }

    const derived = deriveLogicalCoordinates(target, filePath);
    const finalCatalog = normalizeIdentifier(catalogName || derived.catalogName);
    const finalSchema = normalizeIdentifier(schemaName || derived.schemaName) || 'default';
    const finalTable = normalizeIdentifier(tableName || derived.tableName);
    const finalFormat = String(format || path.extname(filePath).slice(1) || 'parquet').toLowerCase();
    const storageUri = getStorageUriForTarget(target, filePath);
    const effectiveTenant = tenantId || target.tenant_id || 'default';
    const lastMod = lastModified || new Date().toISOString();

    if (catalogName && target.catalog_name !== finalCatalog) {
        await db.run('UPDATE targets SET catalog_name = ? WHERE target_id = ?', [finalCatalog, targetId]).catch(() => {});
    }

    const id = crypto.createHash('md5').update(`${targetId}_${finalCatalog}.${finalSchema}.${finalTable}_${filePath}`).digest('hex');
    let serializedSchema = typeof schemaJson === 'string'
        ? schemaJson
        : (schemaJson ? JSON.stringify(schemaJson) : null);
    let finalRowCount = Number(rowCount || 0);

    if (!serializedSchema && finalFormat === 'parquet' && fs.existsSync(filePath)) {
        try {
            const safeLocal = filePath.replace(/\\/g, '/');
            const disc = await discoverParquetSchemaWithDuckDB(`read_parquet('${safeLocal}')`);
            if (disc && Array.isArray(disc.columns) && disc.columns.length > 0) {
                serializedSchema = JSON.stringify(disc.columns);
                if (finalRowCount === 0 && disc.rowCount > 0) finalRowCount = disc.rowCount;
            }
        } catch (_) {}
    }

    await db.run(
        `INSERT OR REPLACE INTO metadata_catalog (
            id, target_id, catalog_name, schema_name, table_name,
            storage_uri, file_path, file_name, file_size, row_count,
            format, schema_json, tenant_id, last_modified
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            targetId,
            finalCatalog,
            finalSchema,
            finalTable,
            storageUri,
            filePath,
            path.basename(filePath),
            Number(fileSize || 0),
            finalRowCount,
            finalFormat,
            serializedSchema,
            effectiveTenant,
            lastMod
        ]
    );

    return {
        id,
        targetId,
        catalogName: finalCatalog,
        schemaName: finalSchema,
        tableName: finalTable,
        fullName: `${finalCatalog}.${finalSchema}.${finalTable}`,
        storageUri,
        filePath,
        fileSize: Number(fileSize || 0),
        rowCount: finalRowCount,
        format: finalFormat,
        columns: serializedSchema ? JSON.parse(serializedSchema) : [],
        tenantId: effectiveTenant
    };
}

async function discoverParquetSchemaWithDuckDB(localOrRemoteExpr, initFn = null) {
    const duckdb = require('duckdb');
    const tempDb = new duckdb.Database(':memory:');
    const conn = tempDb.connect();

    const allAsync = (q) => new Promise((resolve, reject) => {
        conn.all(q, (err, rows) => err ? reject(err) : resolve(rows || []));
    });

    try {
        if (typeof initFn === 'function') {
            await initFn(conn, allAsync);
        }
        const descRows = await allAsync(`DESCRIBE SELECT * FROM ${localOrRemoteExpr}`);
        let rowCount = 0;
        try {
            const cntRows = await allAsync(`SELECT COUNT(*) AS cnt FROM ${localOrRemoteExpr}`);
            rowCount = Number(cntRows[0]?.cnt || 0);
        } catch (_) {}

        const columns = descRows.map(r => ({
            name: r.column_name,
            type: r.column_type,
            nullable: r.null !== 'NO'
        }));
        return { columns, rowCount };
    } finally {
        try { tempDb.close(); } catch (_) {}
    }
}

async function refreshTargetCatalog(userId, targetId, options = {}) {
    const target = await db.get('SELECT * FROM targets WHERE target_id = ?', [targetId]);
    if (!target) throw new Error(`Target ${targetId} not found`);

    const rawFiles = options.files || await listFiles(targetId);
    const files = rawFiles.filter(f => f && f.name && !f.name.endsWith('/'));

    const prevRows = await db.all('SELECT file_path, catalog_name, schema_name, table_name, schema_json, row_count FROM metadata_catalog WHERE target_id = ?', [targetId]).catch(() => []);
    const prevMap = new Map();
    for (const r of prevRows) {
        if (r.file_path) prevMap.set(r.file_path, r);
    }

    await db.run('DELETE FROM metadata_catalog WHERE target_id = ?', [targetId]);

    const autoDescribeExts = new Set(['parquet', 'csv', 'tsv', 'iceberg', 'json', 'jsonl', 'ndjson']);
    const discoveredEntries = [];
    let schemasDetected = 0;

    for (const file of files) {
        const ext = String(
            file.format ||
            (file.name.toLowerCase().includes('.iceberg') ? 'iceberg' : path.extname(file.name).slice(1) || 'parquet')
        ).toLowerCase();

        const prev = prevMap.get(file.name);
        const coords = deriveLogicalCoordinates(target, file.name);
        const catalogName = prev?.catalog_name || coords.catalogName;
        const schemaName = prev?.schema_name || coords.schemaName;
        const tableName = prev?.table_name || coords.tableName;

        let schemaJson = file.schemaJson || prev?.schema_json || null;
        let rowCount = Number(file.rowCount ?? prev?.row_count ?? 0);

        if ((!schemaJson || options.forceDescribe) && autoDescribeExts.has(ext)) {
            if (file.localPath && fs.existsSync(file.localPath)) {
                try {
                    const safeLocal = file.localPath.replace(/\\/g, '/').replace(/'/g, "''");
                    const expr = ext === 'parquet'
                        ? `read_parquet('${safeLocal}')`
                        : (ext === 'csv' || ext === 'tsv' ? `read_csv_auto('${safeLocal}')` : `'${safeLocal}'`);
                    const info = await discoverParquetSchemaWithDuckDB(expr);
                    schemaJson = JSON.stringify(info.columns);
                    rowCount = info.rowCount;
                } catch (_) {}
            } else if (typeof options.describeRunner === 'function') {
                try {
                    const info = await options.describeRunner(file, target);
                    if (info && Array.isArray(info.columns) && info.columns.length > 0) {
                        schemaJson = JSON.stringify(info.columns);
                        rowCount = Number(info.rowCount || 0);
                    }
                } catch (_) {}
            }
        }

        if (schemaJson) schemasDetected++;

        const entry = await registerCatalogEntry({
            targetId,
            catalogName,
            schemaName,
            tableName,
            filePath: file.name,
            fileSize: Number(file.size || 0),
            rowCount,
            format: ext,
            schemaJson,
            tenantId: target.tenant_id || 'default',
            lastModified: file.lastModified || new Date().toISOString()
        });
        discoveredEntries.push(entry);
    }

    return {
        targetId,
        targetName: target.target_name,
        catalogName: normalizeIdentifier(target.catalog_name || target.target_name),
        indexedCount: discoveredEntries.length,
        schemasDetected,
        entries: discoveredEntries
    };
}

async function getCatalogTree(user = {}) {
    const accessibleTargets = await getAccessibleTargets(user);
    const targetMap = new Map(accessibleTargets.map(t => [t.target_id, t]));
    if (targetMap.size === 0) {
        return { catalogs: [], flatTables: [] };
    }

    const userTenant = user.tenant_id || 'default';
    const rawCatalogRows = await db.all(
        `SELECT m.*, t.target_name, t.provider_type, t.bucket, t.endpoint, t.region,
                t.catalog_name AS target_catalog_name, t.default_schema AS target_default_schema,
                t.tenant_id AS target_tenant_id
         FROM metadata_catalog m
         JOIN targets t ON m.target_id = t.target_id
         WHERE COALESCE(t.tenant_id, 'default') = ?
         ORDER BY COALESCE(m.catalog_name, t.catalog_name, t.target_name), COALESCE(m.schema_name, 'default'), COALESCE(m.table_name, m.file_name)`,
        [userTenant]
    );

    const catalogsMap = new Map();
    const flatTables = [];

    for (const row of rawCatalogRows) {
        const target = targetMap.get(row.target_id);
        if (!target) continue; // Enforces per-user RBAC permissions

        const coords = deriveLogicalCoordinates(target, row.file_path || row.file_name);
        const catalogName = normalizeIdentifier(row.catalog_name || target.catalog_name || coords.catalogName);
        const schemaName = normalizeIdentifier(row.schema_name || coords.schemaName) || 'default';
        const tableName = normalizeIdentifier(row.table_name || coords.tableName);
        const fullName = `${catalogName}.${schemaName}.${tableName}`;
        const storageUri = row.storage_uri || coords.storageUri;

        let columns = [];
        if (row.schema_json) {
            try { columns = JSON.parse(row.schema_json); } catch (_) {}
        }

        if (!catalogsMap.has(catalogName)) {
            catalogsMap.set(catalogName, {
                catalogName,
                targetId: target.target_id,
                targetName: target.target_name,
                providerType: target.provider_type,
                bucket: target.bucket,
                region: target.region,
                schemasMap: new Map()
            });
        }

        const catObj = catalogsMap.get(catalogName);
        if (!catObj.schemasMap.has(schemaName)) {
            catObj.schemasMap.set(schemaName, {
                schemaName,
                tables: []
            });
        }

        const tableEntry = {
            id: row.id,
            catalogName,
            schemaName,
            tableName,
            fullName,
            targetId: target.target_id,
            targetName: target.target_name,
            providerType: target.provider_type,
            bucket: target.bucket,
            filePath: row.file_path,
            fileName: row.file_name,
            storageUri,
            format: row.format || 'parquet',
            fileSize: Number(row.file_size || 0),
            rowCount: Number(row.row_count || 0),
            columns,
            lastModified: row.last_modified
        };

        catObj.schemasMap.get(schemaName).tables.push(tableEntry);
        flatTables.push(tableEntry);
    }

    const catalogs = Array.from(catalogsMap.values()).map(c => ({
        catalogName: c.catalogName,
        targetId: c.targetId,
        targetName: c.targetName,
        providerType: c.providerType,
        bucket: c.bucket,
        region: c.region,
        schemas: Array.from(c.schemasMap.values())
    }));

    return { catalogs, flatTables };
}

async function lookupCatalogTable(catalogName, schemaName, tableName, tenantId = 'default') {
    const cName = normalizeIdentifier(catalogName);
    const sName = normalizeIdentifier(schemaName);
    const tName = normalizeIdentifier(tableName);

    // 1. Direct match on metadata_catalog (catalog_name, schema_name, table_name)
    const rows = await db.all(
        `SELECT m.*, t.target_name, t.provider_type, t.bucket, t.endpoint, t.region,
                t.catalog_name AS target_catalog_name, t.default_schema AS target_default_schema,
                t.base_prefix AS target_base_prefix, t.tenant_id AS target_tenant_id
         FROM metadata_catalog m
         JOIN targets t ON m.target_id = t.target_id`
    );

    // Check if the reference matches an entry in another tenant first so we can raise an explicit TENANT_ISOLATION_VIOLATION
    let crossTenantMatch = null;

    for (const row of rows) {
        const coords = deriveLogicalCoordinates(
            {
                target_name: row.target_name,
                provider_type: row.provider_type,
                bucket: row.bucket,
                catalog_name: row.target_catalog_name,
                default_schema: row.target_default_schema,
                base_prefix: row.target_base_prefix
            },
            row.file_path || row.file_name
        );

        const rowCat = normalizeIdentifier(row.catalog_name || row.target_catalog_name || coords.catalogName);
        const rowSchema = normalizeIdentifier(row.schema_name || coords.schemaName) || 'default';
        const rowTable = normalizeIdentifier(row.table_name || coords.tableName);
        const rowTenant = row.tenant_id || row.target_tenant_id || 'default';

        const matches3Part = cName && sName && tName && rowCat === cName && rowSchema === sName && rowTable === tName;
        const matches2PartCatTable = !sName && cName && tName && rowCat === cName && rowTable === tName;
        const matches2PartSchemaTable = !cName && sName && tName && rowSchema === sName && rowTable === tName;

        if (matches3Part || matches2PartCatTable || matches2PartSchemaTable) {
            if (rowTenant !== tenantId) {
                crossTenantMatch = { row, rowCat, rowSchema, rowTable, rowTenant };
                continue;
            }
            return {
                ...row,
                catalogName: rowCat,
                schemaName: rowSchema,
                tableName: rowTable,
                fullName: `${rowCat}.${rowSchema}.${rowTable}`,
                storageUri: row.storage_uri || coords.storageUri
            };
        }
    }

    if (crossTenantMatch) {
        const err = new Error(
            `Tenant security violation: Table '${cName ? cName + '.' : ''}${sName ? sName + '.' : ''}${tName}' belongs to tenant '${crossTenantMatch.rowTenant}' and cannot be accessed by tenant '${tenantId}'.`
        );
        err.code = 'TENANT_ISOLATION_VIOLATION';
        err.statusCode = 403;
        throw err;
    }

    // 2. Fallback: match target by catalog_name and synthesize path <schema>/<table>.parquet
    const allTargets = await db.all('SELECT * FROM targets');
    for (const t of allTargets) {
        const tCat = normalizeIdentifier(t.catalog_name || t.target_name);
        if (tCat === cName) {
            const tTenant = t.tenant_id || 'default';
            if (tTenant !== tenantId) {
                const err = new Error(
                    `Tenant security violation: Catalog '${cName}' belongs to tenant '${tTenant}' and cannot be accessed by tenant '${tenantId}'.`
                );
                err.code = 'TENANT_ISOLATION_VIOLATION';
                err.statusCode = 403;
                throw err;
            }
            const inferredPath = sName && sName !== 'default'
                ? `${sName}/${tName}.parquet`
                : `${tName}.parquet`;
            return {
                id: null,
                target_id: t.target_id,
                target_name: t.target_name,
                provider_type: t.provider_type,
                bucket: t.bucket,
                file_path: inferredPath,
                file_name: `${tName}.parquet`,
                file_size: 0,
                format: 'parquet',
                schema_json: null,
                catalogName: tCat,
                schemaName: sName || 'default',
                tableName: tName,
                fullName: `${tCat}.${sName || 'default'}.${tName}`,
                storageUri: getStorageUriForTarget(t, inferredPath)
            };
        }
    }

    return null;
}

const SQL_RESERVED_FOLLOWERS = new Set([
    'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'JOIN',
    'ON', 'USING', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
    'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW', 'QUALIFY', 'FETCH', 'FOR'
]);

async function resolveFederatedSql(sql, context = {}) {
    const user = context.user || {
        user_id: context.userId || 'admin',
        role: context.role || (context.userId === 'admin' ? 'admin' : 'user'),
        tenant_id: context.tenantId || 'default'
    };
    const userTenant = user.tenant_id || 'default';

    // Collect CTE names so we never mistake a CTE for a table
    const cteNames = new Set();
    const cteRe = /\b(?:WITH(?:\s+RECURSIVE)?|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s*\(/gi;
    let m;
    while ((m = cteRe.exec(sql)) !== null) {
        cteNames.add(m[1].toLowerCase());
    }

    const referencedTargetsMap = new Map();
    const referencedTables = [];
    const aliasMap = new Map(); // fullName -> aliasOrTableName

    // Match 3-part logical table references in FROM / JOIN clauses:
    // e.g. FROM aws_customers.crm.customers [AS c | c]
    //      INNER JOIN azure_sales.sales.orders [AS o | o]
    const threePartRegex = /\b(FROM|JOIN)\s+((?:["'`]?[a-zA-Z_][a-zA-Z0-9_-]*["'`]?)\s*\.\s*(?:["'`]?[a-zA-Z_][a-zA-Z0-9_-]*["'`]?)\s*\.\s*(?:["'`]?[a-zA-Z_][a-zA-Z0-9_-]*["'`]?))(?:\s+(?:AS\s+)?(["'`]?[a-zA-Z_][a-zA-Z0-9_]*["'`]?))?/gi;

    const replacements = [];
    let match;
    while ((match = threePartRegex.exec(sql)) !== null) {
        const keyword = match[1];
        const rawThreePart = match[2];
        const maybeAlias = match[3];
        const cleanParts = rawThreePart.split('.').map(p => normalizeIdentifier(p));
        if (cleanParts.length !== 3) continue;

        const [catName, schName, tblName] = cleanParts;
        if (cteNames.has(catName)) continue;

        const entry = await lookupCatalogTable(catName, schName, tblName, userTenant);
        if (!entry) {
            const err = new Error(`Catalog table '${catName}.${schName}.${tblName}' not found in metadata catalog.`);
            err.code = 'CATALOG_TABLE_NOT_FOUND';
            err.statusCode = 404;
            throw err;
        }

        // Enforce RBAC & tenant isolation on the target backing this catalog table
        const target = await checkUserTargetReadAccess(user, entry.target_id);
        referencedTargetsMap.set(target.target_id, target);

        let hasExplicitAlias = false;
        let effectiveAlias = tblName;
        if (maybeAlias) {
            const upperAlias = maybeAlias.replace(/^["'`]+|["'`]+$/g, '').toUpperCase();
            if (!SQL_RESERVED_FOLLOWERS.has(upperAlias)) {
                hasExplicitAlias = true;
                effectiveAlias = maybeAlias;
            }
        }

        aliasMap.set(`${catName}.${schName}.${tblName}`, effectiveAlias.replace(/^["'`]+|["'`]+$/g, ''));

        const placeholderScanUri = entry.storageUri;
        const fmt = String(entry.format || 'parquet').toLowerCase();
        let scanExpr;
        if (fmt === 'iceberg') {
            scanExpr = `iceberg_scan('${placeholderScanUri}')`;
        } else if (fmt === 'csv' || fmt === 'tsv') {
            scanExpr = `read_csv_auto('${placeholderScanUri}')`;
        } else if (fmt === 'json' || fmt === 'jsonl' || fmt === 'ndjson') {
            scanExpr = `read_json_auto('${placeholderScanUri}')`;
        } else {
            scanExpr = `read_parquet('${placeholderScanUri}')`;
        }

        let replacementText;
        if (hasExplicitAlias) {
            replacementText = `${keyword} ${scanExpr} AS ${effectiveAlias}`;
        } else {
            const trailingPart = maybeAlias ? ` ${maybeAlias}` : '';
            replacementText = `${keyword} ${scanExpr} AS ${tblName}${trailingPart}`;
        }

        replacements.push({
            start: match.index,
            end: match.index + match[0].length,
            replacementText
        });

        referencedTables.push({
            fullName: `${catName}.${schName}.${tblName}`,
            catalogName: catName,
            schemaName: schName,
            tableName: tblName,
            alias: effectiveAlias.replace(/^["'`]+|["'`]+$/g, ''),
            targetId: target.target_id,
            targetName: target.target_name,
            providerType: target.provider_type,
            bucket: target.bucket,
            filePath: entry.file_path,
            storageUri: placeholderScanUri,
            format: fmt,
            fileSize: Number(entry.file_size || 0),
            rowCount: Number(entry.row_count || 0),
            schemaJson: entry.schema_json || null
        });
    }

    let rewrittenSql = sql;
    for (let i = replacements.length - 1; i >= 0; i--) {
        const r = replacements[i];
        rewrittenSql = rewrittenSql.slice(0, r.start) + r.replacementText + rewrittenSql.slice(r.end);
    }

    // Rewrite any 4-part column qualifiers (e.g. aws_customers.crm.customers.customer_id -> c.customer_id)
    for (const [fullTbl, aliasName] of aliasMap.entries()) {
        const escaped = fullTbl.split('.').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*\\.\\s*');
        const fourPartColRe = new RegExp(`\\b${escaped}\\s*\\.\\s*([a-zA-Z_][a-zA-Z0-9_]*)\\b`, 'gi');
        rewrittenSql = rewrittenSql.replace(fourPartColRe, `${aliasName}.$1`);
    }

    return {
        rewrittenSql,
        referencedTargets: Array.from(referencedTargetsMap.values()),
        referencedTables,
        isFederated: referencedTargetsMap.size > 1 || referencedTables.length > 0
    };
}

module.exports = {
    normalizeIdentifier,
    stripKnownExtension,
    getStorageUriForTarget,
    deriveLogicalCoordinates,
    getAccessibleTargets,
    checkUserTargetReadAccess,
    registerCatalogEntry,
    discoverParquetSchemaWithDuckDB,
    refreshTargetCatalog,
    getCatalogTree,
    lookupCatalogTable,
    resolveFederatedSql
};

