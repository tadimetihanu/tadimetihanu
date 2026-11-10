const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { createConnector } = require('./connectors');
const { redactConnectionConfig } = require('./crypto');
const {
    initFederationCatalogs,
    listCatalogs,
    registerCatalog,
    getConnectorForCatalog,
    syncCatalogMetadata,
    executeFederatedQuery,
    explainFederatedQuery,
    generateVisualJoinSql,
    cancelFederatedQuery,
    logFederationAudit,
    clearMetadataCache
} = require('./index');

const router = express.Router();

function resolveTenantId(req) {
    return (
        req.headers['x-tenant-id'] ||
        req.body?.tenant_id ||
        req.query?.tenant_id ||
        req.user?.tenant_id ||
        'default_tenant'
    );
}

// 1. GET /api/federation/catalogs
router.get('/catalogs', authenticate, async (req, res) => {
    try {
        const tenantId = resolveTenantId(req);
        const catalogs = await listCatalogs(tenantId);
        res.json({ success: true, tenantId, catalogs });
    } catch (err) {
        res.status(err.statusCode || 500).json({ success: false, error: err.message });
    }
});

// 2. POST /api/federation/catalogs
router.post('/catalogs', authenticate, async (req, res) => {
    try {
        const tenantId = resolveTenantId(req);
        const {
            catalog_name,
            catalogName,
            source_type,
            sourceType,
            auth_method,
            authMethod,
            connection_config,
            connectionConfig
        } = req.body || {};

        const registered = await registerCatalog({
            catalogName: catalog_name || catalogName,
            sourceType: source_type || sourceType,
            authMethod: auth_method || authMethod || 'key_secret',
            connectionConfig: connection_config || connectionConfig || {},
            tenantId,
            userId: req.user.user_id,
            ipAddress: req.ip
        });
        res.json({ success: true, catalog: registered });
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
});

// 3. DELETE /api/federation/catalogs/:catalogName
router.delete('/catalogs/:catalogName', authenticate, async (req, res) => {
    try {
        const tenantId = resolveTenantId(req);
        const { catalogName } = req.params;
        const cat = await db.get(
            `SELECT * FROM federation_catalogs WHERE tenant_id = ? AND (lower(catalog_name) = lower(?) OR catalog_id = ?)`,
            [tenantId, catalogName, catalogName]
        );
        if (!cat) {
            return res.status(404).json({ success: false, error: `Catalog '${catalogName}' not found` });
        }

        await db.run(`DELETE FROM federation_column_metadata WHERE catalog_id = ?`, [cat.catalog_id]);
        await db.run(`DELETE FROM federation_tables WHERE catalog_id = ?`, [cat.catalog_id]);
        await db.run(`DELETE FROM federation_schemas WHERE catalog_id = ?`, [cat.catalog_id]);
        await db.run(`DELETE FROM federation_connections WHERE connection_id = ?`, [cat.connection_id]);
        await db.run(`DELETE FROM federation_catalogs WHERE catalog_id = ?`, [cat.catalog_id]);
        clearMetadataCache();

        await logFederationAudit({
            tenantId,
            userId: req.user.user_id,
            action: 'DELETE_CATALOG',
            resourceType: 'catalog',
            resourceId: cat.catalog_id,
            catalogName: cat.catalog_name,
            status: 'success',
            ipAddress: req.ip
        });

        res.json({ success: true, message: `Catalog '${cat.catalog_name}' removed` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. POST /api/federation/test-connection
router.post('/test-connection', authenticate, async (req, res) => {
    try {
        const tenantId = resolveTenantId(req);
        const {
            catalog_name,
            catalogName,
            source_type,
            sourceType,
            auth_method,
            authMethod,
            connection_config,
            connectionConfig
        } = req.body || {};

        const name = catalog_name || catalogName;
        const sType = source_type || sourceType;
        const cfg = connection_config || connectionConfig;

        // If testing an existing registered catalog without passing raw credentials
        if (name && (!cfg || Object.keys(cfg).length === 0)) {
            const { connector, catalog } = await getConnectorForCatalog(name, tenantId);
            const result = await connector.testConnection();
            await db.run(
                `UPDATE federation_catalogs SET status = 'connected', last_successful_connection = CURRENT_TIMESTAMP WHERE catalog_id = ?`,
                [catalog.catalog_id]
            );
            return res.json({
                success: true,
                ...result,
                capabilities: connector.getCapabilities(),
                redactedConfig: redactConnectionConfig(connector.config)
            });
        }

        const connector = createConnector({
            catalog_name: name || 'test_catalog',
            source_type: sType,
            auth_method: auth_method || authMethod || 'key_secret',
            connectionConfig: cfg || {}
        });

        const result = await connector.testConnection();
        res.json({
            success: true,
            ...result,
            capabilities: connector.getCapabilities(),
            redactedConfig: redactConnectionConfig(cfg || {})
        });
    } catch (err) {
        res.status(400).json({
            success: false,
            status: 'error',
            error: err.message
        });
    }
});

// 5. GET /api/federation/schemas
router.get('/schemas', authenticate, async (req, res) => {
    try {
        await initFederationCatalogs();
        const tenantId = resolveTenantId(req);
        const catalogFilter = req.query.catalog || req.query.catalog_name;

        let sql = `
            SELECT s.schema_id, s.catalog_id, c.catalog_name, c.source_type, s.schema_name, s.created_at
            FROM federation_schemas s
            JOIN federation_catalogs c ON s.catalog_id = c.catalog_id
            WHERE s.tenant_id = ?
        `;
        const params = [tenantId];

        if (catalogFilter) {
            sql += ` AND lower(c.catalog_name) = lower(?)`;
            params.push(catalogFilter);
        }
        sql += ` ORDER BY c.catalog_name ASC, s.schema_name ASC`;

        const schemas = await db.all(sql, params);
        res.json({ success: true, schemas });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 6. GET /api/federation/tables
router.get('/tables', authenticate, async (req, res) => {
    try {
        await initFederationCatalogs();
        const tenantId = resolveTenantId(req);
        const catalogFilter = req.query.catalog || req.query.catalog_name;
        const schemaFilter = req.query.schema || req.query.schema_name;

        let sql = `
            SELECT t.table_id, t.schema_id, t.catalog_id, c.catalog_name, c.source_type,
                   t.schema_name, t.table_name, t.format, t.row_count_estimate, t.size_bytes, t.updated_at
            FROM federation_tables t
            JOIN federation_catalogs c ON t.catalog_id = c.catalog_id
            WHERE t.tenant_id = ?
        `;
        const params = [tenantId];

        if (catalogFilter) {
            sql += ` AND lower(c.catalog_name) = lower(?)`;
            params.push(catalogFilter);
        }
        if (schemaFilter) {
            sql += ` AND lower(t.schema_name) = lower(?)`;
            params.push(schemaFilter);
        }
        sql += ` ORDER BY c.catalog_name ASC, t.schema_name ASC, t.table_name ASC`;

        const tables = await db.all(sql, params);
        const allCols = await db.all(
            `SELECT table_id, column_name, data_type, ordinal_position, is_nullable
             FROM federation_column_metadata
             WHERE tenant_id = ?
             ORDER BY ordinal_position ASC`,
            [tenantId]
        );

        const colMap = new Map();
        for (const col of allCols) {
            if (!colMap.has(col.table_id)) colMap.set(col.table_id, []);
            colMap.get(col.table_id).push(col);
        }

        const enriched = tables.map(t => ({
            ...t,
            fqn: `${t.catalog_name}.${t.schema_name}.${t.table_name}`,
            columns: colMap.get(t.table_id) || []
        }));

        res.json({ success: true, tables: enriched });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 7. POST /api/federation/query
router.post('/query', authenticate, async (req, res) => {
    try {
        const tenantId = resolveTenantId(req);
        const {
            sql,
            preferredEngine = 'auto',
            enablePushdown = true,
            timeoutMs = 60000,
            cacheStatus = 'MISS',
            executionId = null
        } = req.body || {};

        const result = await executeFederatedQuery({
            sql,
            user: req.user,
            tenantId,
            preferredEngine,
            enablePushdown,
            timeoutMs,
            cacheStatus,
            executionId,
            ipAddress: req.ip
        });

        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 400).json({
            success: false,
            error: err.message,
            executionId: err.executionId || null,
            failedSource: err.failedSource || null
        });
    }
});

// 8. POST /api/federation/explain
router.post('/explain', authenticate, async (req, res) => {
    try {
        const tenantId = resolveTenantId(req);
        const { sql, preferredEngine = 'auto', enablePushdown = true } = req.body || {};
        const plan = await explainFederatedQuery({
            sql,
            user: req.user,
            tenantId,
            preferredEngine,
            enablePushdown
        });
        res.json(plan);
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
});

// 9. POST /api/federation/cancel/:executionId
router.post('/cancel/:executionId', authenticate, async (req, res) => {
    try {
        const { executionId } = req.params;
        const result = cancelFederatedQuery(executionId);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 10. POST /api/federation/visual-join
router.post('/visual-join', authenticate, async (req, res) => {
    try {
        const sql = generateVisualJoinSql(req.body || {});
        res.json({ success: true, sql });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// 11. GET /api/federation/history
router.get('/history', authenticate, async (req, res) => {
    try {
        await initFederationCatalogs();
        const tenantId = resolveTenantId(req);
        const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
        const rows = await db.all(
            `SELECT * FROM federation_query_history
             WHERE tenant_id = ?
             ORDER BY created_at DESC
             LIMIT ${limit}`,
            [tenantId]
        );
        const history = rows.map(r => ({
            ...r,
            catalogs_referenced: (() => {
                try { return JSON.parse(r.catalogs_referenced || '[]'); } catch (_) { return []; }
            })(),
            explain_plan: (() => {
                try { return r.explain_plan_json ? JSON.parse(r.explain_plan_json) : null; } catch (_) { return null; }
            })()
        }));
        res.json({ success: true, history });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 12. GET /api/federation/metrics
router.get('/metrics', authenticate, async (req, res) => {
    try {
        await initFederationCatalogs();
        const tenantId = resolveTenantId(req);
        const executionId = req.query.execution_id || req.query.executionId;

        let metricsSql = `SELECT * FROM federation_execution_metrics WHERE tenant_id = ?`;
        const params = [tenantId];
        if (executionId) {
            metricsSql += ` AND execution_id = ?`;
            params.push(executionId);
        }
        metricsSql += ` ORDER BY created_at DESC LIMIT 250`;

        const sourceMetrics = await db.all(metricsSql, params);
        const summaryRows = await db.all(
            `SELECT
                COUNT(*) AS total_queries,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful_queries,
                SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS failed_queries,
                AVG(duration_ms) AS avg_duration_ms,
                SUM(object_bytes_scanned) AS total_object_bytes_scanned,
                SUM(relational_bytes_retrieved) AS total_relational_bytes_retrieved,
                SUM(network_bytes_transferred) AS total_network_bytes,
                SUM(estimated_cost_usd) AS total_billed_cost_usd,
                SUM(on_demand_cost_usd) AS total_ondemand_cost_usd
             FROM federation_query_history
             WHERE tenant_id = ?`,
            [tenantId]
        );

        const byCatalog = await db.all(
            `SELECT
                catalog_name,
                source_type,
                metric_category,
                COUNT(*) AS scan_count,
                SUM(bytes_scanned) AS total_bytes_scanned,
                SUM(bytes_retrieved) AS total_bytes_retrieved,
                SUM(network_bytes) AS total_network_bytes,
                SUM(rows_processed) AS total_rows_processed,
                AVG(scan_duration_ms) AS avg_scan_duration_ms,
                SUM(estimated_cost_usd) AS total_cost_usd
             FROM federation_execution_metrics
             WHERE tenant_id = ?
             GROUP BY catalog_name, source_type, metric_category
             ORDER BY total_bytes_scanned DESC, total_bytes_retrieved DESC`,
            [tenantId]
        );

        const s = summaryRows[0] || {};
        res.json({
            success: true,
            summary: {
                totalQueries: Number(s.total_queries || 0),
                successfulQueries: Number(s.successful_queries || 0),
                failedQueries: Number(s.failed_queries || 0),
                avgDurationMs: Math.round(Number(s.avg_duration_ms || 0)),
                totalObjectBytesScanned: Number(s.total_object_bytes_scanned || 0),
                totalRelationalBytesRetrieved: Number(s.total_relational_bytes_retrieved || 0),
                totalNetworkBytes: Number(s.total_network_bytes || 0),
                totalBilledCostUsd: Number(Number(s.total_billed_cost_usd || 0).toFixed(8)),
                totalOnDemandCostUsd: Number(Number(s.total_ondemand_cost_usd || 0).toFixed(8)),
                ratePerTibUsd: 5.0
            },
            byCatalog,
            sourceMetrics: sourceMetrics.map(m => ({
                ...m,
                pushed_predicates: (() => {
                    try { return JSON.parse(m.pushed_predicates || '[]'); } catch (_) { return []; }
                })(),
                pushed_projections: (() => {
                    try { return JSON.parse(m.pushed_projections || '[]'); } catch (_) { return []; }
                })()
            }))
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 13. GET & POST /api/federation/policies (RBAC management)
router.get('/policies', authenticate, async (req, res) => {
    try {
        const tenantId = resolveTenantId(req);
        const policies = await db.all(
            `SELECT * FROM federation_access_policies WHERE tenant_id = ? ORDER BY created_at DESC`,
            [tenantId]
        );
        res.json({ success: true, policies });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/policies', authenticate, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'Admin access required to configure federation RBAC policies' });
        }
        const tenantId = resolveTenantId(req);
        const {
            subject_id,
            subject_type = 'user',
            catalog_name,
            schema_name = '*',
            table_name = '*',
            can_select = 1,
            can_explain = 1,
            can_manage = 0
        } = req.body || {};

        if (!subject_id || !catalog_name) {
            return res.status(400).json({ success: false, error: 'subject_id and catalog_name are required' });
        }

        const policyId = crypto.randomUUID();
        await db.run(
            `DELETE FROM federation_access_policies
             WHERE tenant_id = ? AND subject_id = ? AND lower(catalog_name) = lower(?) AND lower(schema_name) = lower(?) AND lower(table_name) = lower(?)`,
            [tenantId, subject_id, catalog_name, schema_name, table_name]
        );

        await db.run(
            `INSERT INTO federation_access_policies
             (policy_id, tenant_id, subject_id, subject_type, catalog_name, schema_name, table_name, can_select, can_explain, can_manage)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                policyId,
                tenantId,
                subject_id,
                subject_type,
                catalog_name,
                schema_name,
                table_name,
                can_select ? 1 : 0,
                can_explain ? 1 : 0,
                can_manage ? 1 : 0
            ]
        );

        res.json({ success: true, policy_id: policyId });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 14. GET /api/federation/audit-logs
router.get('/audit-logs', authenticate, async (req, res) => {
    try {
        const tenantId = resolveTenantId(req);
        const logs = await db.all(
            `SELECT * FROM federation_audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`,
            [tenantId]
        );
        res.json({ success: true, logs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;

