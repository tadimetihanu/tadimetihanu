// Complete Server API Verification for Google Drive & Platform Endpoints
const http = require('http');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database('./data/metadata.db');
const adminUser = db.prepare("SELECT * FROM users WHERE role = 'admin'").get();
const SECRET_KEY = process.env.JWT_SECRET || 'super_secret_enterprise_jwt_key_2026';
const token = jwt.sign(
    { user_id: adminUser.user_id, email: adminUser.email, role: adminUser.role },
    SECRET_KEY,
    { expiresIn: '2h' }
);

function makeRequest(port, method, reqPath, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: '127.0.0.1',
            port: port,
            path: reqPath,
            method: method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ status: res.statusCode, body: parsed });
                } catch (e) {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

async function runApiTests() {
    console.log('🚀 Starting Server & API Endpoint Tests on Test Port...\n');
    
    // Import and start server app
    const express = require('express');
    // Start temporary server
    const serverModule = require('./src/server'); // app
    
    // Wait for server to be ready
    await new Promise(r => setTimeout(r, 2000));
    const port = process.env.PORT || 4000;

    let passed = 0;
    let failed = 0;
    function check(cond, msg) {
        if (cond) {
            console.log(`  ✅ [PASS] ${msg}`);
            passed++;
        } else {
            console.error(`  ❌ [FAIL] ${msg}`);
            failed++;
        }
    }

    try {
        // 1. GET /api/targets
        console.log('📋 Test 1: GET /api/targets');
        const targetsRes = await makeRequest(port, 'GET', '/api/targets');
        check(targetsRes.status === 200, 'HTTP 200 returned');
        check(targetsRes.body.success === true, 'Success flag is true');
        const gdriveTarget = targetsRes.body.targets.find(t => t.provider_type === 'gdrive' || t.provider_type === 'googledrive');
        check(gdriveTarget !== undefined, 'Google Drive target is present in target list');
        check(gdriveTarget && gdriveTarget.base_uri.startsWith('gdrive://'), `Base URI correctly formatted (${gdriveTarget?.base_uri})`);

        if (gdriveTarget) {
            const targetId = gdriveTarget.target_id;

            // 2. GET /api/files/:targetId
            console.log('\n📁 Test 2: GET /api/files/:targetId');
            const filesRes = await makeRequest(port, 'GET', `/api/files/${targetId}`);
            check(filesRes.status === 200, 'HTTP 200 returned');
            check(filesRes.body.success === true, 'Success flag is true');
            check(Array.isArray(filesRes.body.files) && filesRes.body.files.length > 0, `Returned ${filesRes.body.files?.length} files`);

            // 3. GET /api/schema/:targetId?fileName=customer_churn_analysis.csv
            console.log('\n📐 Test 3: GET /api/schema/:targetId (Schema Inspector)');
            const schemaRes = await makeRequest(port, 'GET', `/api/schema/${targetId}?fileName=customer_churn_analysis.csv`);
            check(schemaRes.status === 200, 'HTTP 200 returned');
            check(schemaRes.body.success === true, 'Schema inspection succeeded');
            check(Array.isArray(schemaRes.body.columns) && schemaRes.body.columns.length > 0, `Inspected ${schemaRes.body.columns?.length} columns`);
            console.log('     Columns:', schemaRes.body.columns?.map(c => `${c.name} (${c.type})`).join(', '));

            // 4. POST /api/query/:targetId
            console.log('\n💻 Test 4: POST /api/query/:targetId (SQL Query on Google Drive)');
            const queryRes = await makeRequest(port, 'POST', `/api/query/${targetId}`, {
                sql: "SELECT customer_name, monthly_charges, region FROM 'customer_churn_analysis.csv' WHERE status = 'Active' LIMIT 3"
            });
            check(queryRes.status === 200, 'HTTP 200 returned');
            check(queryRes.body.success === true, 'Query succeeded');
            check(Array.isArray(queryRes.body.data) && queryRes.body.data.length > 0, `Returned ${queryRes.body.data?.length} rows`);
            console.log('     Sample Result Row:', JSON.stringify(queryRes.body.data?.[0]));

            // 5. POST /api/admin/test-connection
            console.log('\n🔗 Test 5: POST /api/admin/test-connection (Google Drive)');
            const connRes = await makeRequest(port, 'POST', '/api/admin/test-connection', {
                type: 'gdrive',
                bucket: 'root',
                credentials: 'demo-access:demo-secret'
            });
            check(connRes.status === 200, 'HTTP 200 returned');
            check(connRes.body.success === true, 'Admin test-connection returned success');

            // 6. POST /api/ingestion/start
            console.log('\n🔄 Test 6: POST /api/ingestion/start (Google Drive)');
            const ingestRes = await makeRequest(port, 'POST', '/api/ingestion/start', {
                sourceConfig: {
                    type: 'gdrive',
                    host: 'root',
                    sourcePath: 'customer_churn_analysis.csv'
                },
                targetId: targetId,
                targetFolder: 'incoming_gdrive/'
            });
            check(ingestRes.status === 200, 'HTTP 200 returned');
            check(ingestRes.body.success === true, 'Ingestion succeeded');
        }

    } catch (e) {
        console.error('💥 API test error:', e);
        failed++;
    }

    console.log('\n======================================================');
    console.log(`📊 API Test Summary: ${passed} Passed, ${failed} Failed`);
    console.log('======================================================\n');
    process.exit(failed > 0 ? 1 : 0);
}

runApiTests();
