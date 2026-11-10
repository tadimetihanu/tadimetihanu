const fs = require('fs');
const path = require('path');

/**
 * Common Connector Interface for CloudObjectIQ Cross-Source Data Federation.
 * Every federation connector MUST implement:
 * - connect()
 * - disconnect()
 * - testConnection()
 * - listSchemas()
 * - listTables(schemaName)
 * - getTableSchema(schemaName, tableName)
 * - executeScan(scanSpec)
 * - getCapabilities()
 */
class BaseConnector {
    constructor(catalogConfig = {}) {
        this.catalogId = catalogConfig.catalog_id || catalogConfig.catalogId || 'unknown_catalog_id';
        this.catalogName = catalogConfig.catalog_name || catalogConfig.catalogName || 'unknown_catalog';
        this.sourceType = (catalogConfig.source_type || catalogConfig.sourceType || 'generic').toLowerCase();
        this.tenantId = catalogConfig.tenant_id || catalogConfig.tenantId || 'default_tenant';
        this.authMethod = catalogConfig.auth_method || catalogConfig.authMethod || 'key_secret';
        this.config = catalogConfig.connectionConfig || catalogConfig.config || {};
        this.connected = false;
        this.lastConnectedAt = null;
    }

    async connect() {
        this.connected = true;
        this.lastConnectedAt = new Date().toISOString();
        return { connected: true, connectedAt: this.lastConnectedAt };
    }

    async disconnect() {
        this.connected = false;
        return { connected: false };
    }

    async testConnection() {
        await this.connect();
        return {
            success: true,
            status: 'connected',
            sourceType: this.sourceType,
            catalogName: this.catalogName,
            latencyMs: 4,
            testedAt: new Date().toISOString()
        };
    }

    async listSchemas() {
        throw new Error(`listSchemas() not implemented for connector ${this.sourceType}`);
    }

    async listTables(_schemaName) {
        throw new Error(`listTables() not implemented for connector ${this.sourceType}`);
    }

    async getTableSchema(_schemaName, _tableName) {
        throw new Error(`getTableSchema() not implemented for connector ${this.sourceType}`);
    }

    /**
     * Returns a scan descriptor or materialized rows/DuckDB expression for the federation engine.
     * @param {Object} scanSpec - { schemaName, tableName, alias, columns, predicates, limit }
     */
    async executeScan(_scanSpec) {
        throw new Error(`executeScan() not implemented for connector ${this.sourceType}`);
    }

    getCapabilities() {
        return {
            sourceType: this.sourceType,
            supportsPredicatePushdown: true,
            supportsProjectionPushdown: true,
            supportsLimitPushdown: true,
            supportsAggregationPushdown: false,
            supportsJoinPushdown: false,
            supportsDynamicFiltering: true,
            supportsIceberg: false,
            isRelational: false,
            isObjectStorage: false,
            costModel: 'NONE'
        };
    }

    /**
     * Helper to build safe SQL projection list from requested columns
     */
    buildProjectionList(requestedColumns, availableColumns = []) {
        if (!Array.isArray(requestedColumns) || requestedColumns.length === 0 || requestedColumns.includes('*')) {
            return '*';
        }
        const availSet = new Set(availableColumns.map(c => (typeof c === 'string' ? c : c.column_name || c.name).toLowerCase()));
        const validCols = requestedColumns.filter(col => {
            const clean = String(col).trim();
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(clean)) return false;
            return availSet.size === 0 || availSet.has(clean.toLowerCase());
        });
        if (validCols.length === 0) return '*';
        return validCols.map(c => `"${c}"`).join(', ');
    }

    /**
     * Helper to validate and combine pushed-down SQL predicates safely
     */
    buildSafeWhereClause(predicates = []) {
        if (!Array.isArray(predicates) || predicates.length === 0) return '';
        const safePreds = predicates
            .map(p => String(p).trim())
            .filter(p => p.length > 0 && !/;\s*(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|ATTACH|DETACH|COPY|PRAGMA)/i.test(p));
        if (safePreds.length === 0) return '';
        return `WHERE ${safePreds.map(p => `(${p})`).join(' AND ')}`;
    }
}

module.exports = { BaseConnector };

