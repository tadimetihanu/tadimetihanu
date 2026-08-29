const { S3Client, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { BlobServiceClient } = require('@azure/storage-blob');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const gdrive = require('./gdrive');

const db = new Database('./data/metadata.db');
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS metadata_catalog (
            id TEXT PRIMARY KEY,
            target_id TEXT,
            file_path TEXT,
            file_name TEXT,
            file_size INTEGER,
            format TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    const cols = db.prepare("PRAGMA table_info(metadata_catalog)").all().map(c => c.name);
    if (!cols.includes('last_modified')) {
        db.prepare("ALTER TABLE metadata_catalog ADD COLUMN last_modified TEXT").run();
    }
} catch (e) {}

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
        { name: 'census_data.parquet', size: 22016, lastModified: '2025-03-15T07:30:00Z' },
        { name: 'ecommerce_orders.iceberg', size: 52428, lastModified: '2026-03-29T10:00:00Z', format: 'iceberg', isIceberg: true },
        { name: 'cloud_telemetry.iceberg', size: 45056, lastModified: '2026-03-29T11:00:00Z', format: 'iceberg', isIceberg: true }
    ],
    azure: [
        { name: 'marketing_trends.parquet', size: 18432, lastModified: '2025-03-14T10:00:00Z' },
        { name: 'telemetry.json', size: 2048, lastModified: '2025-03-14T11:00:00Z' },
        { name: 'financial_transactions.iceberg', size: 65536, lastModified: '2026-03-29T12:00:00Z', format: 'iceberg', isIceberg: true }
    ]
};

// ── Unified Storage API ───────────────────────────────────────

async function testConnection(config) {
    try {
        if (config.type === 'gdrive' || config.type === 'googledrive') {
            return await gdrive.testConnection(config);
        } else if (config.type === 's3' || config.type === 'r2' || config.type === 'cloudflare') {
            const S3 = require('@aws-sdk/client-s3');
            const ep = _ensureProtocol(config.endpoint);
            const client = new S3.S3Client({
                endpoint: ep, region: (config.type === 'r2' || config.type === 'cloudflare' ? 'auto' : 'us-east-1'), forcePathStyle: true,
                credentials: { accessKeyId: config.credentials.split(':')[0], secretAccessKey: config.credentials.split(':')[1] }
            });
            await client.send(new S3.HeadBucketCommand({ Bucket: config.bucket }));
            return { success: true };
        } else if (config.type === 'azure' || config.type === 'adls') {
            const Azure = require('@azure/storage-blob');
            // Use dummy target for builder
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
        if (target.provider_type === 'minio' || target.provider_type === 's3' || target.provider_type === 'r2' || target.provider_type === 'cloudflare') {
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
            const containerName = target.bucket;
            if (!containerName) {
                throw new Error(`Target '${target.target_name}' has no container/bucket configured. Please set a container name in Admin Center.`);
            }
            const containerClient = blobService.getContainerClient(containerName);
            try {
                for await (const blob of containerClient.listBlobsFlat()) {
                    results.push({
                        name: blob.name,
                        size: blob.properties.contentLength || 0,
                        lastModified: blob.properties.lastModified?.toISOString?.() || '',
                    });
                }
            } catch (azureErr) {
                if (azureErr.statusCode === 404 || (azureErr.message && azureErr.message.includes('specified container does not exist'))) {
                    let availableContainers = [];
                    try {
                        for await (const c of blobService.listContainers()) {
                            availableContainers.push(c.name);
                        }
                    } catch (e) {}
                    const hint = availableContainers.length > 0
                        ? ` Available containers in account: [${availableContainers.join(', ')}]. Update the target bucket in Admin Center.`
                        : ` Please create container '${containerName}' in your Azure Storage Account portal.`;
                    throw new Error(`Azure Container '${containerName}' not found.${hint}`);
                }
                throw azureErr;
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
                // Remove prefix to get relative filename
                let relPath = f.path;
                if (relPath.startsWith(dbfsPath)) relPath = relPath.slice(dbfsPath.length);
                if (relPath.startsWith('/')) relPath = relPath.slice(1);
                return {
                    name: relPath || f.path,
                    size: f.file_size || 0,
                    lastModified: f.modification_time ? new Date(f.modification_time).toISOString() : ''
                };
            });
        } else if (target.provider_type === 'gdrive' || target.provider_type === 'googledrive') {
            results = await gdrive.listFiles(target);
        } else {
            throw new Error(`Provider ${target.provider_type} not implemented`);
        }

        // Group Spark & Iceberg datasets (directories ending in .parquet, .orc, .csv, .json, .delta, .iceberg or containing /metadata/)
        const datasets = new Map();
        const rawResults = [];

        for (const f of results) {
            // Check if this file is inside an Iceberg table directory (either ending in .iceberg/ or containing /metadata/ /data/)
            let icebergMatch = f.name.match(/^(.*?)\.iceberg(?:\/|$)/i);
            if (!icebergMatch) {
                const parts = f.name.split('/');
                if (parts.length >= 2 && (parts.includes('metadata') || parts.includes('data'))) {
                    const tableRoot = parts[0];
                    if (f.name.toLowerCase().includes('metadata') && (f.name.toLowerCase().endsWith('.json') || f.name.toLowerCase().endsWith('.avro') || f.name.toLowerCase().endsWith('.text'))) {
                        icebergMatch = [f.name, tableRoot];
                    }
                }
            }

            const match = f.name.match(/^(.*?\.(?:parquet|orc|csv|json|delta|iceberg))\//i);
            if (icebergMatch) {
                const rawTableName = icebergMatch[1];
                const datasetName = rawTableName.endsWith('.iceberg') ? rawTableName : `${rawTableName}.iceberg`;
                if (!datasets.has(datasetName)) {
                    datasets.set(datasetName, {
                        name: datasetName,
                        size: 0,
                        lastModified: f.lastModified,
                        format: 'iceberg',
                        isIceberg: true
                    });
                }
                datasets.get(datasetName).size += f.size;
            } else if (match) {
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

        // Filter out metadata files that confuse DuckDB/Users
        const ignoredExtensions = ['.crc', '.tmp', '.pending'];
        const ignoredNames = ['_success', '_metadata', '_common_metadata'];

        return finalResults.filter(f => {
            const name = f.name.toLowerCase();
            const basename = path.basename(name).toLowerCase();
            if (ignoredNames.includes(basename)) return false;
            if (ignoredExtensions.some(ext => name.endsWith(ext))) return false;
            if (basename.startsWith('.')) return false; // Hide hidden files
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

    if (target.provider_type === 'minio' || target.provider_type === 's3' || target.provider_type === 'r2' || target.provider_type === 'cloudflare') {
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
        try { await containerClient.createIfNotExists(); } catch (e) {}
        const blockBlob = containerClient.getBlockBlobClient(filename);
        await blockBlob.upload(buffer, buffer.length, {
            blobHTTPHeaders: { blobContentType: mimetype || 'application/octet-stream' },
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

    if (target.provider_type === 'gdrive' || target.provider_type === 'googledrive') {
        return await gdrive.uploadFile(target, filename, buffer, mimetype);
    }

    throw new Error(`Upload not implemented for ${target.provider_type}`);
}

async function uploadStream(targetId, filename, stream, mimetype, sizeHint) {
    const target = getTarget(targetId);

    if (target.provider_type === 'minio' || target.provider_type === 's3' || target.provider_type === 'r2' || target.provider_type === 'cloudflare') {
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
        try { await containerClient.createIfNotExists(); } catch (e) {}
        const blockBlob = containerClient.getBlockBlobClient(filename);
        
        await blockBlob.uploadStream(stream, 4 * 1024 * 1024, 4, {
            blobHTTPHeaders: { blobContentType: mimetype || 'application/octet-stream' }
        });
        return { container: target.bucket, key: filename };
    }

    if (target.provider_type === 'gdrive' || target.provider_type === 'googledrive') {
        return await gdrive.uploadStream(target, filename, stream, mimetype);
    }

    throw new Error(`Upload stream not implemented for ${target.provider_type}`);
}

async function downloadFile(targetId, filename, destPath) {
    const fs = require('fs');
    const target = getTarget(targetId);

    // Auto-strip prefixes to prevent NoSuchKey errors
    let cleanFilename = filename;
    const s3Prefix = `s3://${target.bucket}/`;
    const r2Prefix = `r2://${target.bucket}/`;
    const azPrefix = `az://${target.bucket}/`;
    const gdPrefix = `gdrive://${target.bucket}/`;
    
    if (cleanFilename.startsWith(s3Prefix)) {
        cleanFilename = cleanFilename.replace(s3Prefix, '');
    } else if (cleanFilename.startsWith(r2Prefix)) {
        cleanFilename = cleanFilename.replace(r2Prefix, '');
    } else if (cleanFilename.startsWith(azPrefix)) {
        cleanFilename = cleanFilename.replace(azPrefix, '');
    } else if (cleanFilename.startsWith(gdPrefix)) {
        cleanFilename = cleanFilename.replace(gdPrefix, '');
    } else if (cleanFilename.startsWith(`${target.bucket}/`)) {
        cleanFilename = cleanFilename.replace(`${target.bucket}/`, '');
    }
    // Remove leading slash if any
    if (cleanFilename.startsWith('/')) {
        cleanFilename = cleanFilename.substring(1);
    }

    if (target.provider_type === 'minio' || target.provider_type === 's3' || target.provider_type === 'r2' || target.provider_type === 'cloudflare') {
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

    if (target.provider_type === 'gdrive' || target.provider_type === 'googledrive') {
        return await gdrive.downloadFile(target, cleanFilename, destPath);
    }

    throw new Error(`Download not implemented for ${target.provider_type}`);
}

async function createIcebergTable(targetId, rawTableName, sourceDataOrSql, description = '') {
    const target = getTarget(targetId);
    let tableName = (rawTableName || 'custom_dataset').trim().replace(/[^a-zA-Z0-9_\-.]/g, '_');
    if (!tableName.toLowerCase().endsWith('.iceberg')) {
        tableName += '.iceberg';
    }

    const duckdb = require('duckdb');
    const db = new duckdb.Database(':memory:');
    const runSql = (q) => new Promise((resolve, reject) => {
        db.run(q, (err) => err ? reject(err) : resolve());
    });
    const allSql = (q) => new Promise((resolve, reject) => {
        db.all(q, (err, rows) => err ? reject(err) : resolve(rows));
    });

    const os = require('os');
    const tempDir = path.join(os.tmpdir(), `iceberg-build-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const tempParquetPath = path.join(tempDir, '00000-0-data.parquet').replace(/\\/g, '/');

    let rowCount = 0;
    let schemaFields = [];

    if (typeof sourceDataOrSql === 'string') {
        // Execute SQL via engine to leverage catalog mapping and cloud credentials
        const { runQuery } = require('../query/engine');
        const rows = await runQuery('admin', sourceDataOrSql, targetId);
        if (!rows || rows.length === 0) {
            throw new Error('The SQL query returned 0 rows. Cannot create an empty Iceberg table.');
        }
        sourceDataOrSql = rows;
    }

    if (Array.isArray(sourceDataOrSql) && sourceDataOrSql.length > 0) {
        // Source is an array of records
        rowCount = sourceDataOrSql.length;
        const tempJsonPath = path.join(tempDir, 'data.json').replace(/\\/g, '/');
        // Handle BigInt serialization safely
        const jsonStr = JSON.stringify(sourceDataOrSql, (k, v) => typeof v === 'bigint' ? Number(v) : v);
        fs.writeFileSync(tempJsonPath, jsonStr, 'utf8');

        const descRes = await allSql(`DESCRIBE SELECT * FROM read_json_auto('${tempJsonPath}')`);
        schemaFields = descRes.map((col, idx) => {
            let fieldType = 'string';
            const t = col.column_type.toLowerCase();
            if (t.includes('int8') || t.includes('bigint') || t.includes('hugeint')) fieldType = 'long';
            else if (t.includes('int') || t.includes('smallint') || t.includes('tinyint')) fieldType = 'int';
            else if (t.includes('double') || t.includes('float') || t.includes('decimal') || t.includes('real')) fieldType = 'double';
            else if (t.includes('bool')) fieldType = 'boolean';
            else if (t.includes('date')) fieldType = 'date';
            else if (t.includes('time')) fieldType = 'timestamp';
            return {
                id: idx + 1,
                name: col.column_name,
                required: false,
                type: fieldType
            };
        });

        await runSql(`COPY (SELECT * FROM read_json_auto('${tempJsonPath}')) TO '${tempParquetPath}' (FORMAT PARQUET)`);
    } else {
        throw new Error('No data or SQL query provided to create Iceberg table');
    }

    const parquetBuffer = fs.readFileSync(tempParquetPath);
    const tableUuid = crypto.randomUUID();
    const snapshotId = Math.floor(100000 + Math.random() * 900000);
    const prefix = (target.provider_type === 'azure' || target.provider_type === 'adls') ? 'az://' : 's3://';
    const location = `${prefix}${target.bucket || 'datalake'}/${tableName}`;

    const metadataJson = {
        "format-version": 2,
        "table-uuid": tableUuid,
        "location": location,
        "last-sequence-number": 1,
        "last-updated-ms": Date.now(),
        "last-column-id": schemaFields.length,
        "current-schema-id": 0,
        "schemas": [
            {
                "type": "struct",
                "schema-id": 0,
                "fields": schemaFields
            }
        ],
        "partition-specs": [{ "spec-id": 0, "fields": [] }],
        "default-spec-id": 0,
        "last-partition-id": 0,
        "properties": {
            "write.format.default": "parquet",
            "comment": description || `Created via CloudObjectIQ on ${new Date().toISOString()}`
        },
        "current-snapshot-id": snapshotId,
        "snapshots": [
            {
                "snapshot-id": snapshotId,
                "timestamp-ms": Date.now(),
                "summary": {
                    "operation": "append",
                    "added-data-files": "1",
                    "added-records": String(rowCount),
                    "total-data-files": "1",
                    "total-records": String(rowCount)
                },
                "manifest-list": `${location}/metadata/snap-${snapshotId}-1.avro`
            }
        ],
        "snapshot-log": [
            {
                "timestamp-ms": Date.now(),
                "snapshot-id": snapshotId
            }
        ]
    };

    const metadataBuffer = Buffer.from(JSON.stringify(metadataJson, null, 2), 'utf8');
    const versionHintBuffer = Buffer.from('1\n', 'utf8');

    // 1. Upload files to cloud target if configured
    try {
        await uploadFile(targetId, `${tableName}/data/00000-0-data.parquet`, parquetBuffer, 'application/octet-stream');
        await uploadFile(targetId, `${tableName}/metadata/v1.metadata.json`, metadataBuffer, 'application/json');
        await uploadFile(targetId, `${tableName}/metadata/version-hint.text`, versionHintBuffer, 'text/plain');
    } catch (upErr) {
        console.warn(`[Iceberg Upload Notice] Cloud upload skipped/fallback: ${upErr.message}`);
    }

    // 2. Write to local sample and cache directories for fast local querying
    const localDestDirs = [
        path.join(__dirname, '..', '..', 'data', 'samples', tableName),
        path.join(__dirname, '..', '..', 'minio_data', 'datalake', tableName),
        path.join(process.env.USERPROFILE || 'C:\\Users\\tadim', '.gdrive_cache', tableName)
    ];

    for (const lDir of localDestDirs) {
        try {
            const dataDir = path.join(lDir, 'data');
            const metaDir = path.join(lDir, 'metadata');
            fs.mkdirSync(dataDir, { recursive: true });
            fs.mkdirSync(metaDir, { recursive: true });
            fs.writeFileSync(path.join(dataDir, '00000-0-data.parquet'), parquetBuffer);
            fs.writeFileSync(path.join(metaDir, 'v1.metadata.json'), metadataBuffer);
            fs.writeFileSync(path.join(metaDir, 'version-hint.text'), versionHintBuffer);
        } catch (e) {}
    }

    // 3. Register in SQLite metadata_catalog
    const metaDbPath = path.join(__dirname, '..', '..', 'data', 'metadata.db');
    if (fs.existsSync(metaDbPath)) {
        const metaDb = new Database(metaDbPath);
        metaDb.exec(`
            CREATE TABLE IF NOT EXISTS metadata_catalog (
                id TEXT PRIMARY KEY,
                target_id TEXT,
                file_path TEXT,
                file_name TEXT,
                file_size INTEGER,
                format TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        try {
            const cols = metaDb.prepare("PRAGMA table_info(metadata_catalog)").all().map(c => c.name);
            if (!cols.includes('last_modified')) {
                metaDb.prepare("ALTER TABLE metadata_catalog ADD COLUMN last_modified TEXT").run();
            }
        } catch (e) {}

        const catId = crypto.createHash('md5').update(`${targetId}_${tableName}`).digest('hex');
        try {
            metaDb.prepare(`
                INSERT OR REPLACE INTO metadata_catalog (id, target_id, file_path, file_name, file_size, format, last_modified)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(catId, targetId, tableName, tableName, parquetBuffer.length + metadataBuffer.length, 'iceberg', new Date().toISOString());
        } catch (insErr) {
            metaDb.prepare(`
                INSERT OR REPLACE INTO metadata_catalog (id, target_id, file_path, file_name, file_size, format)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(catId, targetId, tableName, tableName, parquetBuffer.length + metadataBuffer.length, 'iceberg');
        }
    }

    // Clean temp dir
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}

    return {
        tableName,
        rowCount,
        columns: schemaFields,
        location,
        targetName: target.target_name
    };
}

async function appendIcebergRecords(targetId, rawTableName, sourceDataOrSql) {
    const target = getTarget(targetId);
    let tableName = (rawTableName || '').trim().replace(/[^a-zA-Z0-9_\-.]/g, '_');
    if (!tableName.toLowerCase().endsWith('.iceberg')) {
        tableName += '.iceberg';
    }

    const duckdb = require('duckdb');
    const db = new duckdb.Database(':memory:');
    const runSql = (q) => new Promise((resolve, reject) => {
        db.run(q, (err) => err ? reject(err) : resolve());
    });
    const allSql = (q) => new Promise((resolve, reject) => {
        db.all(q, (err, rows) => err ? reject(err) : resolve(rows));
    });

    const os = require('os');
    const tempDir = path.join(os.tmpdir(), `iceberg-append-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Find previous data files to determine next file index
    const localSampleDir = path.join(__dirname, '..', '..', 'data', 'samples', tableName);
    const minioSampleDir = path.join(__dirname, '..', '..', 'minio_data', 'datalake', tableName);
    let tableDir = fs.existsSync(localSampleDir) ? localSampleDir : minioSampleDir;
    
    let existingDataFiles = [];
    let prevMetadata = null;
    let nextVersionNum = 2;

    if (fs.existsSync(tableDir)) {
        const dDir = path.join(tableDir, 'data');
        if (fs.existsSync(dDir)) {
            existingDataFiles = fs.readdirSync(dDir).filter(f => f.endsWith('.parquet'));
        }
        const mDir = path.join(tableDir, 'metadata');
        if (fs.existsSync(mDir)) {
            const hintPath = path.join(mDir, 'version-hint.text');
            if (fs.existsSync(hintPath)) {
                const hint = parseInt(fs.readFileSync(hintPath, 'utf8').trim()) || 1;
                nextVersionNum = hint + 1;
                const vPath = path.join(mDir, `v${hint}.metadata.json`);
                if (fs.existsSync(vPath)) {
                    try { prevMetadata = JSON.parse(fs.readFileSync(vPath, 'utf8')); } catch (e) {}
                }
            }
        }
    }

    const nextFileIndex = existingDataFiles.length || 1;
    const newFileName = `0000${nextFileIndex}-0-data.parquet`;
    const tempParquetPath = path.join(tempDir, newFileName).replace(/\\/g, '/');

    let addedRows = 0;
    if (typeof sourceDataOrSql === 'string') {
        let sql = sourceDataOrSql.trim();
        const pathMatch = sql.match(/(?:from\s+|read_[a-z_]+\s*\(\s*|iceberg_[a-z_]+\s*\(\s*)['"]([^'"]+)['"]/i);
        if (pathMatch) {
            const logicalName = pathMatch[1];
            const sampleCandidates = [
                path.join(__dirname, '..', '..', 'data', 'samples', logicalName),
                path.join(__dirname, '..', '..', 'minio_data', 'datalake', logicalName),
                path.join(process.env.USERPROFILE || 'C:\\Users\\tadim', '.gdrive_cache', logicalName)
            ];
            for (const sp of sampleCandidates) {
                if (fs.existsSync(sp)) {
                    sql = sql.replace(pathMatch[1], sp.replace(/\\/g, '/'));
                    break;
                }
            }
        }
        await runSql(`COPY (${sql}) TO '${tempParquetPath}' (FORMAT PARQUET)`);
        const rows = await allSql(`SELECT * FROM read_parquet('${tempParquetPath}')`);
        addedRows = rows.length;
        if (addedRows === 0) {
            throw new Error('The SQL query returned 0 rows to insert.');
        }
    } else if (Array.isArray(sourceDataOrSql) && sourceDataOrSql.length > 0) {
        addedRows = sourceDataOrSql.length;
        const tempJsonPath = path.join(tempDir, 'data.json').replace(/\\/g, '/');
        const jsonStr = JSON.stringify(sourceDataOrSql, (k, v) => typeof v === 'bigint' ? Number(v) : v);
        fs.writeFileSync(tempJsonPath, jsonStr, 'utf8');
        await runSql(`COPY (SELECT * FROM read_json_auto('${tempJsonPath}')) TO '${tempParquetPath}' (FORMAT PARQUET)`);
    } else {
        throw new Error('No records or SQL query provided to insert into Iceberg table.');
    }

    const newParquetBuffer = fs.readFileSync(tempParquetPath);

    const snapshotId = Math.floor(100000 + Math.random() * 900000);
    const prefix = (target.provider_type === 'azure' || target.provider_type === 'adls') ? 'az://' : 's3://';
    const location = `${prefix}${target.bucket || 'datalake'}/${tableName}`;

    const prevTotalRecords = prevMetadata?.snapshots?.[prevMetadata.snapshots.length - 1]?.summary?.['total-records'] 
        ? parseInt(prevMetadata.snapshots[prevMetadata.snapshots.length - 1].summary['total-records']) 
        : 0;
    const totalRecords = prevTotalRecords + addedRows;

    const newSnapshot = {
        "snapshot-id": snapshotId,
        "parent-snapshot-id": prevMetadata?.['current-snapshot-id'] || null,
        "timestamp-ms": Date.now(),
        "summary": {
            "operation": "append",
            "added-data-files": "1",
            "added-records": String(addedRows),
            "total-data-files": String(existingDataFiles.length + 1),
            "total-records": String(totalRecords)
        },
        "manifest-list": `${location}/metadata/snap-${snapshotId}-${nextVersionNum}.avro`
    };

    const newMetadata = prevMetadata ? {
        ...prevMetadata,
        "last-sequence-number": (prevMetadata['last-sequence-number'] || 1) + 1,
        "last-updated-ms": Date.now(),
        "current-snapshot-id": snapshotId,
        "snapshots": [...(prevMetadata.snapshots || []), newSnapshot],
        "snapshot-log": [...(prevMetadata['snapshot-log'] || []), { "timestamp-ms": Date.now(), "snapshot-id": snapshotId }]
    } : {
        "format-version": 2,
        "table-uuid": crypto.randomUUID(),
        "location": location,
        "last-sequence-number": 1,
        "last-updated-ms": Date.now(),
        "last-column-id": 10,
        "current-schema-id": 0,
        "schemas": [{ "type": "struct", "schema-id": 0, "fields": [] }],
        "partition-specs": [{ "spec-id": 0, "fields": [] }],
        "default-spec-id": 0,
        "last-partition-id": 0,
        "properties": { "write.format.default": "parquet" },
        "current-snapshot-id": snapshotId,
        "snapshots": [newSnapshot],
        "snapshot-log": [{ "timestamp-ms": Date.now(), "snapshot-id": snapshotId }]
    };

    const metadataBuffer = Buffer.from(JSON.stringify(newMetadata, null, 2), 'utf8');
    const versionHintBuffer = Buffer.from(`${nextVersionNum}\n`, 'utf8');

    // 1. Upload to cloud storage target
    try {
        await uploadFile(targetId, `${tableName}/data/${newFileName}`, newParquetBuffer, 'application/octet-stream');
        await uploadFile(targetId, `${tableName}/metadata/v${nextVersionNum}.metadata.json`, metadataBuffer, 'application/json');
        await uploadFile(targetId, `${tableName}/metadata/version-hint.text`, versionHintBuffer, 'text/plain');
    } catch (upErr) {
        console.warn(`[Iceberg Append Cloud Upload Notice] ${upErr.message}`);
    }

    // 2. Write to local directories
    const localDestDirs = [
        path.join(__dirname, '..', '..', 'data', 'samples', tableName),
        path.join(__dirname, '..', '..', 'minio_data', 'datalake', tableName),
        path.join(process.env.USERPROFILE || 'C:\\Users\\tadim', '.gdrive_cache', tableName)
    ];
    for (const lDir of localDestDirs) {
        try {
            const dataDir = path.join(lDir, 'data');
            const metaDir = path.join(lDir, 'metadata');
            fs.mkdirSync(dataDir, { recursive: true });
            fs.mkdirSync(metaDir, { recursive: true });
            fs.writeFileSync(path.join(dataDir, newFileName), newParquetBuffer);
            fs.writeFileSync(path.join(metaDir, `v${nextVersionNum}.metadata.json`), metadataBuffer);
            fs.writeFileSync(path.join(metaDir, 'version-hint.text'), versionHintBuffer);
        } catch (e) {}
    }

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}

    return {
        success: true,
        tableName,
        addedRows,
        totalRows: totalRecords,
        snapshotId,
        version: nextVersionNum,
        dataFile: newFileName
    };
}

module.exports = {
    listFiles,
    uploadFile,
    uploadStream,
    downloadFile,
    createIcebergTable,
    appendIcebergRecords,
    getTarget,
    testConnection,
    gdrive
};
