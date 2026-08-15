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
        const sql = "SELECT * FROM 'az://inseekdata/orcdata/part-00000-43c63acf-d5c6-4101-b40b-7a0536d295a2-c000.snappy.orc' LIMIT 5";

        console.log('Executing query...');
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
        console.log('Query result:', JSON.stringify(queryData, null, 2).substring(0, 1000));
    } catch (err) {
        console.error('Error:', err.message);
    }
}

test();
