// Storage driver — Supports dynamic targets via the metadata DB
const { S3Client, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { BlobServiceClient } = require('@azure/storage-blob');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure the data directory exists before opening SQLite
const dbPath = process.env.DATABASE_PATH || path.resolve(process.cwd(), 'data/metadata.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// ── Target Resolver ───────────────────────────────────────────
function getTarget(targetId) {
    const target = db.prepare('SELECT * FROM targets WHERE target_id = ?').get(targetId);
    if (!target) throw new Error(`Target ${targetId} not found`);
    return target;
}

function _ensureProtocol(url) {
    if (!url) return url;
    let out = url.trim();
    if (!/^https?:\/\//i.test(out)) out = 'http://' + out;
    return out.replace(/\/+$/, '');
}

// ── Client Builders ─────────────────────────────────────────────
function getS3Client(target) {
    let ep = target.endpoint || '';
    if (ep && !ep.startsWith('http://') && !ep.startsWith('https://')) {
        ep = 'http://' + ep;
    }

    return new S3Client({
        endpoint:    ep,
        region:      target.region || 'us-east-1',
        credentials: { 
            accessKeyId: target.access_key, 
            secretAccessKey: target.secret_key 
        },
        forcePathStyle: true,
    });
}

function getAzureClient(target) {
    let connStr = target.endpoint || '';
    
    // 💡 Auto-Switch DFS to BLOB for SDK Handshake compatibility
    connStr = connStr.replace(/dfs\.core\.windows\.net/g, 'core.windows.net');

    // 🏗️ Build Connection String if only a raw URL or AccountName is provided
    if (connStr && !connStr.includes('AccountKey=')) {
        let accountName = target.access_key || '';
        let accountKey = target.secret_key || '';
        
        // Extract account name from URL if possible
        if (!accountName && connStr.includes('.blob.core.windows.net')) {
            const match = connStr.match(/https?:\/\/([^.]+)\.blob\.core\.windows\.net/);
            if (match) accountName = match[1];
        } else if (!accountName && !connStr.includes('.')) {
            accountName = connStr; // Assume raw string is the account name
        }

        if (accountName && accountKey) {
            connStr = `DefaultEndpointsProtocol=https;AccountName=${accountName};AccountKey=${accountKey};EndpointSuffix=core.windows.net`;
        }
    }

    if (!connStr) throw new Error('Azure Connection String or Endpoint is missing');
    return BlobServiceClient.fromConnectionString(connStr);
}

// ── Mock Fallbacks (for local/demo reliability) ────────────────
const MOCKS = {
    minio: [
        { name: 'iris.parquet', size: 17408, lastModified: '2025-03-15T06:00:00Z' },
        { name: 'census_data.parquet', size: 22016, lastModified: '2025-03-15T07:30:00Z' }
    ],
    azure: [
        { name: 'marketing_trends.parquet', size: 18432, lastModified: '2025-03-14T10:00:00Z' },
        { name: 'telemetry.json', size: 2048, lastModified: '2025-03-14T11:00:00Z' }
    ]
};

// ── Unified Storage API ───────────────────────────────────────

async function testConnection(config) {
    try {
        if (config.type === 's3') {
            const S3 = require('@aws-sdk/client-s3');
            const ep = _ensureProtocol(config.endpoint);
            const client = new S3.S3Client({
                endpoint: ep, region: 'us-east-1', forcePathStyle: true,
                credentials: { accessKeyId: config.credentials.split(':')[0], secretAccessKey: config.credentials.split(':')[1] }
            });
            await client.send(new S3.HeadBucketCommand({ Bucket: config.bucket }));
            return { success: true };
        } else if (config.type === 'azure' || config.type === 'adls') {
            const Azure = require('@azure/storage-blob');
            const blobService = getAzureClient({ 
               endpoint: config.endpoint, 
               access_key: config.credentials.split(':')[0], 
               secret_key: config.credentials.split(':')[1] 
            });
            const container = blobService.getContainerClient(config.bucket);
            await container.getProperties();
            return { success: true };
        }
    } catch (err) {
        throw new Error(`Test failed: ${err.message}`);
    }
}

async function listFiles(targetId) {
    const target = getTarget(targetId);

    try {
        let results = [];
        if (target.provider_type === 'minio' || target.provider_type === 's3') {
            const s3 = getS3Client(target);
            const cmd = new ListObjectsV2Command({ Bucket: target.bucket });
            const res = await s3.send(cmd);
            results = (res.Contents || []).map(o => ({
                name: o.Key, size: o.Size,
                lastModified: o.LastModified?.toISOString?.() || '',
            }));
        } 
        
        else if (target.provider_type === 'azure' || target.provider_type === 'adls') {
            const blobService = getAzureClient(target);
            const containerClient = blobService.getContainerClient(target.bucket);
            for await (const blob of containerClient.listBlobsFlat()) {
                results.push({
                    name: blob.name,
                    size: blob.properties.contentLength || 0,
                    lastModified: blob.properties.lastModified?.toISOString?.() || '',
                });
            }
        } else if (target.provider_type === 'databricks') {
            const ep = target.endpoint.replace(/\/$/, '');
            const token = target.access_key;
            let dbfsPath = target.bucket || '/';
            if (!dbfsPath.startsWith('/')) dbfsPath = '/' + dbfsPath;
            
            const res = await fetch(`${ep}/api/2.0/dbfs/list?path=${encodeURIComponent(dbfsPath)}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) {
                const txt = await res.text();
                throw new Error(`Databricks list failed: ${res.status} ${txt}`);
            }
            const data = await res.json();
            results = (data.files || []).map(f => {
                let relPath = f.path;
                if (relPath.startsWith(dbfsPath)) relPath = relPath.slice(dbfsPath.length);
                if (relPath.startsWith('/')) relPath = relPath.slice(1);
                return {
                    name: relPath || f.path,
                    size: f.file_size || 0,
                    lastModified: f.modification_time ? new Date(f.modification_time).toISOString() : ''
                };
            });
        } else {
            throw new Error(`Provider ${target.provider_type} not implemented`);
        }

        const datasets = new Map();
        const rawResults = [];

        for (const f of results) {
            const match = f.name.match(/^(.*?\. (?:parquet|orc|csv|json|delta|iceberg))\//i);
            if (match) {
                const datasetName = match[1];
                if (!datasets.has(datasetName)) {
                    datasets.set(datasetName, {
                        name: datasetName,
                        size: 0,
                        lastModified: f.lastModified
                    });
                }
                datasets.get(datasetName).size += f.size;
            } else {
                rawResults.push(f);
            }
        }
        
        const finalResults = [...rawResults, ...Array.from(datasets.values())];

        const ignoredExtensions = ['.crc', '.tmp', '.pending'];
        const ignoredNames = ['_success', '_metadata', '_common_metadata'];

        return finalResults.filter(f => {
            const name = f.name.toLowerCase();
            const basename = path.basename(name).toLowerCase();
            if (ignoredNames.includes(basename)) return false;
            if (ignoredExtensions.some(ext => name.endsWith(ext))) return false;
            if (basename.startsWith('.')) return false;
            return true;
        });
    } catch (err) {
        if (target.provider_type === 'azure' || target.provider_type === 'adls') {
            console.error(`❌ [Azure-Critical] Scan Failed for ${target.target_name}`);
            console.error(`   Endpoint: ${target.endpoint}`);
            console.error(`   Bucket: ${target.bucket}`);
            console.error(`   Error: ${err.message}`);
            if (err.code) console.error(`   Error Code: ${err.code}`);
        }
        console.error(`[Storage Error] ${target.target_name} (${target.provider_type}): ${err.message}`);
        throw err;
    }
}

async function uploadFile(targetId, filename, buffer, mimetype) {
    const target = getTarget(targetId);

    if (target.provider_type === 'minio' || target.provider_type === 's3') {
        const s3 = getS3Client(target);
        const cmd = new PutObjectCommand({
            Bucket: target.bucket, Key: filename,
            Body: buffer, ContentType: mimetype || 'application/octet-stream',
        });
        await s3.send(cmd);
        return { bucket: target.bucket, key: filename };
    }

    if (target.provider_type === 'azure' || target.provider_type === 'adls') {
        const blobService = getAzureClient(target);
        const containerClient = blobService.getContainerClient(target.bucket);
        const blockBlob = containerClient.getBlockBlobClient(filename);
        await blockBlob.upload(buffer, buffer.length, {
            blobHTTPHeaders: { blobContentType: mimetype || 'application/octet-stream' }
        });
        return { container: target.bucket, key: filename };
    }

    if (target.provider_type === 'databricks') {
        const ep = target.endpoint.replace(/\/$/, '');
        const token = target.access_key;
        let destPath = target.bucket || '/';
        if (!destPath.endsWith('/')) destPath += '/';
        destPath += filename;
        
        const res = await fetch(`${ep}/api/2.0/dbfs/put`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: destPath,
                contents: buffer.toString('base64'),
                overwrite: true
            })
        });
        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`Databricks upload failed: ${res.status} ${txt}`);
        }
        return { bucket: target.bucket, key: destPath };
    }

    throw new Error(`Upload not implemented for ${target.provider_type}`);
}

async function uploadStream(targetId, filename, stream, mimetype, sizeHint) {
    const target = getTarget(targetId);

    if (target.provider_type === 'minio' || target.provider_type === 's3') {
        const { Upload } = require('@aws-sdk/lib-storage');
        const s3 = getS3Client(target);
        
        const parallelUploads3 = new Upload({
            client: s3,
            params: {
                Bucket: target.bucket,
                Key: filename,
                Body: stream,
                ContentType: mimetype || 'application/octet-stream'
            },
            partSize: 5 * 1024 * 1024,
            queueSize: 4
        });
        
        await parallelUploads3.done();
        return { bucket: target.bucket, key: filename };
    }

    if (target.provider_type === 'azure' || target.provider_type === 'adls') {
        const blobService = getAzureClient(target);
        const containerClient = blobService.getContainerClient(target.bucket);
        const blockBlob = containerClient.getBlockBlobClient(filename);
        
        await blockBlob.uploadStream(stream, 4 * 1024 * 1024, 4, {
            blobHTTPHeaders: { blobContentType: mimetype || 'application/octet-stream' }
        });
        return { container: target.bucket, key: filename };
    }

    throw new Error(`Upload stream not implemented for ${target.provider_type}`);
}

async function downloadFile(targetId, filename, destPath) {
    const fs = require('fs');
    const target = getTarget(targetId);

    let cleanFilename = filename;
    const s3Prefix = `s3://${target.bucket}/`;
    const azPrefix = `az://${target.bucket}/`;
    
    if (cleanFilename.startsWith(s3Prefix)) {
        cleanFilename = cleanFilename.replace(s3Prefix, '');
    } else if (cleanFilename.startsWith(azPrefix)) {
        cleanFilename = cleanFilename.replace(azPrefix, '');
    } else if (cleanFilename.startsWith(`${target.bucket}/`)) {
        cleanFilename = cleanFilename.replace(`${target.bucket}/`, '');
    }
    if (cleanFilename.startsWith('/')) {
        cleanFilename = cleanFilename.substring(1);
    }

    if (target.provider_type === 'minio' || target.provider_type === 's3') {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        const s3 = getS3Client(target);
        const cmd = new GetObjectCommand({ Bucket: target.bucket, Key: cleanFilename });
        const res = await s3.send(cmd);
        
        const destStream = fs.createWriteStream(destPath);
        return new Promise((resolve, reject) => {
            res.Body.pipe(destStream)
                .on('error', reject)
                .on('close', resolve);
        });
    }

    if (target.provider_type === 'azure' || target.provider_type === 'adls') {
        const blobService = getAzureClient(target);
        const containerClient = blobService.getContainerClient(target.bucket);
        const blockBlob = containerClient.getBlockBlobClient(cleanFilename);
        await blockBlob.downloadToFile(destPath);
        return;
    }

    if (target.provider_type === 'databricks') {
        const ep = target.endpoint.replace(/\/$/, '');
        const token = target.access_key;
        let srcPath = target.bucket || '/';
        if (!srcPath.endsWith('/')) srcPath += '/';
        srcPath += cleanFilename;

        const res = await fetch(`${ep}/api/2.0/dbfs/read?path=${encodeURIComponent(srcPath)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`Databricks read failed: ${res.status} ${txt}`);
        }
        const data = await res.json();
        fs.writeFileSync(destPath, Buffer.from(data.data, 'base64'));
        return;
    }

    throw new Error(`Download not implemented for ${target.provider_type}`);
}

module.exports = {
    listFiles,
    uploadFile,
    uploadStream,
    downloadFile,
    getTarget,
    testConnection
};
