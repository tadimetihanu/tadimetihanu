const { exec } = require('child_process');
const path = require('path');

/**
 * CloudObjectIQ: Synthetic Data Generator (ORC)
 * --------------------------------------------
 * This script triggers a Spark job inside Docker to generate high-fidelity
 * ORC data, bypassing local Node.js environment restrictions.
 */

console.log('🚀 Initializing Spark Data Generation via Docker...');

// Command to copy the script and run it in Spark
const cmd = `docker cp scripts/generate_orc.py spark-master:/opt/spark/generate_orc.py && ` +
            `docker exec spark-master /opt/spark/bin/spark-submit /opt/spark/generate_orc.py`;

const startTime = Date.now();

exec(cmd, (error, stdout, stderr) => {
    if (error) {
        console.error(`❌ Generation Failed: ${error.message}`);
        if (stderr) console.error(`Stderr: ${stderr}`);
        return;
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('---------------------------------------------------------');
    console.log(stdout);
    console.log(`✅ Success! Logistics ORC data generated in ${duration}s.`);
    console.log(`📂 Location: ./spark_data/logistics_performance_2026.orc`);
    console.log('---------------------------------------------------------');
});

