const { Client } = require('ssh2');

/**
 * Executes a BM25 Search on the remote Milvus server (10.1.2.69)
 * and returns JSON results.
 */
async function searchMilvus(query, category = null) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        const host = '10.1.2.69';
        const username = 'sshuser';
        const password = 'D:/Sparkup';

        conn.on('ready', () => {
            const filterExpr = category && category !== 'All' ? `expr=\"category == '${category}'\",` : '';
            
            // Note: We use a simplified Python bridge executed in a container
            const pythonScript = `
from pymilvus import connections, Collection
import json
import sys

try:
    connections.connect(host="localhost", port="19530")
    col = Collection("text_search")
    col.load()

    results = col.search(
        data=["${query}"],
        anns_field="sparse_vector",
        param={"metric_type": "BM25"},
        limit=12,
        ${filterExpr}
        output_fields=["text", "category", "meta_json"]
    )

    output = []
    if results:
        for hit in results[0]:
            output.append({
                "id": str(hit.id),
                "score": round(float(hit.score), 4),
                "text": hit.entity.get("text"),
                "category": hit.entity.get("category"),
                "metadata": hit.entity.get("meta_json")
            })
    print(json.dumps(output))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

            // Prepare the command (escaped for bash)
            const escapedPython = pythonScript.replace(/"/g, '\\"').replace(/\$/g, '\\$');
            const cmd = `docker run --rm --network host python:3.11-slim bash -c "pip install -q pymilvus && python3 -c \\"${escapedPython}\\""`;

            conn.exec(cmd, (err, stream) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }
                
                let stdout = '';
                stream.on('close', () => {
                    conn.end();
                    try {
                        const parsed = JSON.parse(stdout);
                        resolve(parsed);
                    } catch (e) {
                        console.error('[Milvus-Bridge] Parse Error:', stdout);
                        resolve([]);
                    }
                }).on('data', (data) => {
                    stdout += data;
                }).stderr.on('data', (data) => {
                    // console.error('[Milvus-Bridge] Stderr:', data.toString());
                });
            });
        }).on('error', (err) => {
            reject(err);
        }).connect({
            host,
            port: 22,
            username,
            password,
            readyTimeout: 10000
        });
    });
}

module.exports = { searchMilvus };
