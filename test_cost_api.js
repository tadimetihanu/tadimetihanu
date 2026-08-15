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

        console.log('Fetching cost insights...');
        const res = await fetch('http://localhost:3001/api/admin/cost-insights', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await res.json();
        console.log('Status:', res.status);
        console.log('Data:', JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Error:', err.message);
    }
}

test();
