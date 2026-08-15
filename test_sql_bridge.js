const { submitSparkJob } = require('./src/services/spark');
require('dotenv').config();

async function test() {
    const params = {
        className: null, // Python
        jarPath: '/app/sql_bridge.py',
        master: 'spark://spark-master:7077',
        deployMode: 'client',
        args: ['--sql', 'SELECT 1 as result']
    };
    
    try {
        console.log(`📡 Manually initiating sql_bridge.py submission...`);
        const result = await submitSparkJob(params);
        console.log('✅ Result Status:', result.success);
        console.log('✅ Message:', result.message);
        console.log('✅ Output:', result.output);
    } catch (err) {
        console.error('❌ Submission Failed:', err);
    }
}

test();
