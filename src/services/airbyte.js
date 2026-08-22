const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { getTarget } = require('../drivers/storage');

const AIRBYTE_URL = process.env.AIRBYTE_URL || 'http://localhost:8000/api/v1';
const AIRBYTE_USER = process.env.AIRBYTE_USER || 'airbyte';
const AIRBYTE_PASS = process.env.AIRBYTE_PASS || 'password';

function getHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${AIRBYTE_USER}:${AIRBYTE_PASS}`).toString('base64')
    };
}

/**
 * Checks if the Airbyte local server is running and healthy.
 */
async function checkHealth() {
    try {
        const res = await fetch(`${AIRBYTE_URL}/health`, { headers: getHeaders() });
        const data = await res.json();
        return { online: data.available || data.db === true, raw: data };
    } catch (e) {
        return { online: false, error: e.message };
    }
}

/**
 * Gets the first workspace ID. Airbyte typically creates a default workspace.
 */
async function getWorkspaceId() {
    const res = await fetch(`${AIRBYTE_URL}/workspaces/list`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({})
    });
    if (!res.ok) throw new Error('Failed to fetch workspaces');
    const data = await res.json();
    if (!data.workspaces || data.workspaces.length === 0) throw new Error('No workspace found');
    return data.workspaces[0].workspaceId;
}

/**
 * Auto-creates a MinIO destination in Airbyte.
 */
async function setupMinioDestination(targetId) {
    const target = getTarget(targetId);
    if (!target || (target.provider_type !== 'minio' && target.provider_type !== 's3')) {
        throw new Error('Only MinIO/S3 targets are currently supported for auto-provisioning');
    }

    const workspaceId = await getWorkspaceId();
    
    // We need to fetch the definition ID for the S3 destination
    const defRes = await fetch(`${AIRBYTE_URL}/destination_definitions/list`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({})
    });
    const defData = await defRes.json();
    const s3Def = defData.destinationDefinitions.find(d => d.name === 'S3');
    if (!s3Def) throw new Error('S3 Destination Definition not found in Airbyte');

    const destinationPayload = {
        workspaceId,
        name: `CloudObjectIQ - ${target.target_name}`,
        destinationDefinitionId: s3Def.destinationDefinitionId,
        connectionConfiguration: {
            s3_bucket_name: target.bucket,
            s3_bucket_path: "airbyte_syncs",
            s3_bucket_region: target.region || "us-east-1",
            access_key_id: target.access_key,
            secret_access_key: target.secret_key,
            s3_endpoint: target.endpoint,
            format: {
                format_type: "Parquet"
            }
        }
    };

    const res = await fetch(`${AIRBYTE_URL}/destinations/create`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(destinationPayload)
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Airbyte API Error: ${err}`);
    }

    return await res.json();
}

/**
 * Lists recent sync jobs from all connections in the workspace.
 */
async function getSyncStatuses() {
    try {
        const workspaceId = await getWorkspaceId();
        const res = await fetch(`${AIRBYTE_URL}/connections/list`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ workspaceId })
        });
        
        if (!res.ok) return { connections: [] };
        const data = await res.json();
        
        return { connections: data.connections || [] };
    } catch (e) {
        return { connections: [] };
    }
}

module.exports = {
    checkHealth,
    setupMinioDestination,
    getSyncStatuses
};
