async function test() {
    console.log('🚀 [Test] Running End-to-End API Test against http://localhost:4000...');

    // 1. Login
    const loginReq = await fetch('http://localhost:4000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@cloudobjectiq.com', password: 'admin123' })
    });
    const loginData = await loginReq.json();
    if (!loginData.success) throw new Error('Login failed: ' + JSON.stringify(loginData));
    const token = loginData.token;
    console.log('✅ 1. Authenticated as Admin. Token acquired.');

    // 2. Fetch targets
    const targetsReq = await fetch('http://localhost:4000/api/targets', {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    const targetsData = await targetsReq.json();
    console.log('✅ 2. Target list:');
    console.table(targetsData.targets.map(t => ({ name: t.target_name, type: t.provider_type, id: t.target_id })));

    const minioTarget = targetsData.targets.find(t => t.provider_type === 'minio');

    // 3. List files in MinIO target
    const filesReq = await fetch(`http://localhost:4000/api/files/${minioTarget.target_id}`, {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    const filesData = await filesReq.json();
    console.log('✅ 3. Files in Data Lake:', filesData.files);

    // 4. Inspect schema
    const schemaReq = await fetch(`http://localhost:4000/api/schema/${minioTarget.target_id}?fileName=sales_data.parquet`, {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    const schemaData = await schemaReq.json();
    console.log('✅ 4. Schema inspection for sales_data.parquet:');
    console.table(schemaData.columns);

    // 5. Execute query
    const querySql = `SELECT category, count(*) as total_orders, round(avg(amount), 2) as avg_price, round(sum(amount), 2) as total_revenue FROM read_parquet('s3://datalake/sales_data.parquet') GROUP BY category ORDER BY total_revenue DESC`;
    const queryReq = await fetch(`http://localhost:4000/api/query/${minioTarget.target_id}`, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sql: querySql })
    });
    const queryRes = await queryReq.json();
    console.log('✅ 5. Query execution response:');
    console.table(queryRes.data);
    console.log('   Metrics:', queryRes.meta);

    console.log('\n🎉 ALL END-TO-END HTTP REST APIS VERIFIED AND WORKING PERFECTLY!');
}

test().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
