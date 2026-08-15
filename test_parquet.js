async function test() {
    try {
        console.log('Logging in...');
        const loginRes = await fetch('http://localhost:3001/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'admin@cloudobjectiq.com',
                password: 'admin123'
            })
        });
        const loginData = await loginRes.json();
        const token = loginData.token;
        console.log('Token acquired.');

        const targetId = '28e0979b-53ef-47ba-be22-9942fc54999e';
        const sql = "SELECT * FROM 'az://inseekdata/parquetdata/AJ_LEGAL_HOLDS_DATA_308910_1.parquet' LIMIT 5";

        console.log('Executing Parquet query...');
        const queryRes = await fetch(`http://localhost:3001/api/query/${targetId}`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ sql })
        });

        const queryData = await queryRes.json();
        console.log('Query response status:', queryRes.status);
        if (queryRes.status === 200) {
            console.log('Query results (count):', queryData.data.length);
        } else {
            console.log('Query error:', queryData.error);
        }
    } catch (err) {
        console.error('Error:', err.message);
    }
}

test();
