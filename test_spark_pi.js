const { submitSparkJob } = require('./src/services/spark');
require('dotenv').config();

async function test() {
    const params = {
        className: 'org.apache.spark.examples.SparkPi', // Test with a standard example if python bridge fails
        jarPath: '/opt/spark/examples/jars/spark-examples_2.13-4.1.1.jar',
        master: 'spark://spark-master:7077',
        deployMode: 'client',
        args: ['10']
    };
    
    try {
        console.log(`📡 Manually initiating SparkPi submission...`);
        const result = await submitSparkJob(params);
        console.log('✅ Result Status:', result.success);
        console.log('✅ Result Message:', result.message);
        console.log('✅ Output:', result.output);
    } catch (err) {
        console.error('❌ Submission Failed:', err);
    }
}

test();
