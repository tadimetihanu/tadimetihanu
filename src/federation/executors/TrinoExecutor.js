/**
 * Optional Trino Distributed Execution Backend (`TrinoExecutor`).
 * Connects to a Trino Coordinator REST API (`/v1/statement`) when `TRINO_COORDINATOR_URL` is configured.
 * Never fakes distributed execution: if no Trino coordinator is reachable, it accurately reports its status
 * so `ExecutionRouter` can select `DuckDBExecutor` or surface a clear error if Trino was explicitly forced.
 */
class TrinoExecutor {
    constructor(options = {}) {
        this.coordinatorUrl = (options.coordinatorUrl || process.env.TRINO_COORDINATOR_URL || '').trim();
        this.user = options.user || process.env.TRINO_USER || 'cloudobjectiq_federation';
        this.catalog = options.catalog || 'system';
    }

    isConfigured() {
        return Boolean(this.coordinatorUrl);
    }

    getEngineMetadata() {
        return {
            engineName: 'TrinoExecutor',
            executionMode: 'DISTRIBUTED_TRINO_MPP',
            isDistributed: true,
            configured: this.isConfigured(),
            coordinatorUrl: this.coordinatorUrl || null,
            description: 'Distributed MPP Trino SQL execution cluster for multi-hundred-gigabyte cross-catalog workloads'
        };
    }

    async checkHealth() {
        if (!this.isConfigured()) {
            return { online: false, reason: 'TRINO_COORDINATOR_URL is not configured' };
        }
        try {
            const res = await fetch(`${this.coordinatorUrl.replace(/\/+$/, '')}/v1/info`, {
                method: 'GET',
                headers: { 'X-Trino-User': this.user }
            });
            if (!res.ok) {
                return { online: false, reason: `Trino coordinator HTTP ${res.status}` };
            }
            const info = await res.json();
            return { online: true, nodeVersion: info.nodeVersion, starting: info.starting };
        } catch (err) {
            return { online: false, reason: err.message };
        }
    }

    async executePlan(plan, options = {}) {
        if (!this.isConfigured()) {
            throw new Error(
                'TrinoExecutor is not configured (TRINO_COORDINATOR_URL is unset). Use DuckDBExecutor for single-node federated queries or configure a Trino cluster.'
            );
        }
        const health = await this.checkHealth();
        if (!health.online) {
            throw new Error(`TrinoExecutor cluster is offline: ${health.reason}`);
        }

        // Submit statement to Trino /v1/statement
        const baseUrl = this.coordinatorUrl.replace(/\/+$/, '');
        let res = await fetch(`${baseUrl}/v1/statement`, {
            method: 'POST',
            headers: {
                'X-Trino-User': this.user,
                'Content-Type': 'text/plain'
            },
            body: plan.executableSql
        });
        if (!res.ok) {
            throw new Error(`Trino statement submission failed: HTTP ${res.status}`);
        }

        let payload = await res.json();
        const rows = [];
        let columns = payload.columns || [];

        while (payload.nextUri) {
            if (payload.data) {
                for (const tuple of payload.data) {
                    const obj = {};
                    columns.forEach((c, idx) => {
                        obj[c.name] = tuple[idx];
                    });
                    rows.push(obj);
                }
            }
            const nextRes = await fetch(payload.nextUri, { headers: { 'X-Trino-User': this.user } });
            payload = await nextRes.json();
            if (payload.columns && columns.length === 0) columns = payload.columns;
            if (payload.error) {
                throw new Error(`Trino Execution Error: ${payload.error.message}`);
            }
        }

        if (payload.data && columns.length > 0) {
            for (const tuple of payload.data) {
                const obj = {};
                columns.forEach((c, idx) => {
                    obj[c.name] = tuple[idx];
                });
                rows.push(obj);
            }
        }

        return {
            executionId: options.executionId || `trino_${Date.now()}`,
            engineUsed: 'TrinoExecutor',
            executionMode: 'DISTRIBUTED_TRINO_MPP',
            isDistributed: true,
            rows,
            rowCount: rows.length,
            durationMs: payload.stats?.elapsedTimeMillis || 1,
            sourceMetrics: [],
            physicalPlanText: 'Executed on Distributed Trino Cluster'
        };
    }
}

module.exports = { TrinoExecutor };

