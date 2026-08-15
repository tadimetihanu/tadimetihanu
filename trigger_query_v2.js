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

        const targetId = '9d3a96e1-3622-4e87-b938-fb2b9737ca26';
        const sql = "SELECT * FROM read_csv('az://datainseektech/test_deploy.txt') LIMIT 5";

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
        if (queryRes.status === 200) {
            console.log('Query results:', queryData.data);
        } else {
            console.log('Query error:', queryData.error);
        }
    } catch (err) {
        console.error('Error:', err.message);
    }
}

test();
