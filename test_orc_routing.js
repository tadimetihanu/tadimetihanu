const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');

async function testOrcRedirection() {
    const SECRET_KEY = 'changeme_plz_enterprise_grade';
    const token = jwt.sign({ user_id: 1, email: 'admin@cloudobjectiq.com', role: 'admin' }, SECRET_KEY);

    console.log('🧪 Simulating System ORC Query [Authenticated Routing Check]...');
    
    const sql = "SELECT * FROM read_orc('az://inseekdata/orcdata/part-00001.orc') LIMIT 10";
    
    try {
        const res = await fetch('http://localhost:3001/api/query/81d80fa7-4520-4157-91d7-05a47ce5b2c1', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ sql })
        });
        
        const data = await res.json();
        console.log('--- Server Response ---');
        console.log(JSON.stringify(data, null, 2));
        
        if (data.offloaded) {
            console.log('\n✅ TEST PASSED: System correctly intercepted the ORC query and routed it to Spark.');
        } else {
            console.log('\n❌ TEST FAILED: Routing logic bypassed.');
        }
    } catch (err) {
        console.error('❌ Error:', err.message);
    }
}

testOrcRedirection();
