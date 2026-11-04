const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Spark Job Submission Service
 * Handles executing spark-submit commands from the CloudObjectIQ dashboard.
 * Supports both:
 * 1. Embedded PySpark execution on Render / cloud containers (no Docker daemon)
 * 2. Distributed spark-master execution on local Docker-in-Docker environments
 */
function submitSparkJob(params) {
    return new Promise((resolve, reject) => {
        const { master, deployMode, className, jarPath, conf, args } = params;

        // Detect if a live Docker daemon is accessible
        let useDocker = false;
        if (fs.existsSync('/var/run/docker.sock')) {
            try {
                execSync('docker ps', { stdio: 'ignore', timeout: 2000 });
                useDocker = true;
            } catch (e) {
                useDocker = false;
            }
        }

        const rawScript = jarPath ? jarPath.trim() : '/app/sql_bridge.py';
        let cmd = '';
        let cmdArgs = [];
        let procEnv = { ...process.env };

        if (useDocker) {
            // Local Docker-in-Docker Mode (spark-master container)
            const dockerMaster = (master || 'spark://spark-master:7077')
                .replace('localhost', 'spark-master')
                .replace('127.0.0.1', 'spark-master');

            const finalJarPath = rawScript.replace(/^s3:\/\//, 's3a://');
            
            cmd = 'docker';
            cmdArgs = [
                'exec',
                '-u', 'root',
                'spark-master',
                '/opt/spark/bin/spark-submit',
                '--master', dockerMaster,
                '--deploy-mode', deployMode || 'client',
                '--conf', 'spark.driver.host=spark-master',
                '--packages', 'org.apache.hadoop:hadoop-azure:3.3.4,com.microsoft.azure:azure-storage:8.6.6,org.apache.hadoop:hadoop-aws:3.3.4,com.amazonaws:aws-java-sdk-bundle:1.12.262'
            ];

            if (className) {
                cmdArgs.push('--class', className);
            }

            if (conf) {
                Object.entries(conf).forEach(([k, v]) => {
                    cmdArgs.push('--conf', `${k}=${v}`);
                });
            }

            cmdArgs.push(finalJarPath);
        } else {
            // Embedded PySpark Mode on Render / Cloud Container
            let resolvedScript = rawScript;
            if (!fs.existsSync(resolvedScript)) {
                const localBridge = path.join(process.cwd(), 'sql_bridge.py');
                if (fs.existsSync(localBridge)) {
                    resolvedScript = localBridge;
                }
            }

            cmd = 'python3';
            cmdArgs = [resolvedScript];

            if (conf) {
                procEnv.SPARK_HADOOP_CONF_JSON = JSON.stringify(conf);
            }
            delete procEnv._JAVA_OPTIONS;
            procEnv.SPARK_LOCAL_IP = '127.0.0.1';
            procEnv.SPARK_SUBMIT_OPTS = '-Dspark.testing.memory=471859200';
            procEnv.PYSPARK_PYTHON = procEnv.PYSPARK_PYTHON || 'python3';
            procEnv.PYSPARK_DRIVER_PYTHON = procEnv.PYSPARK_DRIVER_PYTHON || 'python3';
            procEnv.PYSPARK_SUBMIT_ARGS = '--conf spark.testing.memory=471859200 --driver-memory 200m --executor-memory 200m pyspark-shell';
        }

        // Handle arguments properly
        if (args) {
            let rawArgs = [];
            if (Array.isArray(args)) {
                rawArgs = args.flatMap(a => {
                    if (typeof a !== 'string') return [a];
                    return a.match(/(?:[^\s"]+|"(?:\\.|[^"\\])*")+/gs) || [a];
                });
            } else {
                rawArgs = args.match(/(?:[^\s"]+|"(?:\\.|[^"\\])*")+/gs) || [];
            }

            rawArgs.forEach(a => {
                if (typeof a !== 'string') {
                    cmdArgs.push(String(a));
                    return;
                }
                let clean = a.trim();
                if (clean.startsWith('"') && clean.endsWith('"')) clean = clean.substring(1, clean.length - 1);
                if (clean.startsWith("'") && clean.endsWith("'")) clean = clean.substring(1, clean.length - 1);
                cmdArgs.push(clean.replace(/^s3:\/\//, 's3a://'));
            });
        }

        console.log(`🚀 [Spark] Executing: ${cmd} ${cmdArgs.join(' ')} (Engine mode: ${useDocker ? 'docker-cluster' : 'embedded-pyspark'})`);

        const sparkProcess = spawn(cmd, cmdArgs, { env: procEnv });
        let outputData = '';
        let errorData = '';

        sparkProcess.stdout.on('data', (data) => {
            const str = data.toString();
            outputData += str;
            process.stdout.write(`[Spark] ${str}`);
        });

        sparkProcess.stderr.on('data', (data) => {
            const str = data.toString();
            errorData += str;
            process.stderr.write(`[Spark-Error] ${str}`);
        });

        sparkProcess.on('error', (err) => {
            console.error('❌ Failed to start Spark process:', err);
            resolve({
                success: false,
                message: `Failed to spawn Spark engine (${cmd}): ${err.message}`,
                output: err.message,
                data: []
            });
        });

        sparkProcess.on('close', (code) => {
            if (code !== 0) {
                console.error(`❌ Spark job failed with exit code ${code}`);
                return resolve({
                    success: false,
                    message: `Spark job failed with exit code ${code}`,
                    output: errorData || outputData,
                    data: []
                });
            }

            console.log(`✅ Spark job completed successfully.`);
            const result = {
                success: true,
                message: 'Submission completed',
                output: outputData,
                data: []
            };
            
            // Try to read exported results for UI
            const candidatePaths = [
                path.join(process.cwd(), 'data', 'spark_result.json'),
                '/app/data/spark_result.json'
            ];
            for (const resultPath of candidatePaths) {
                if (fs.existsSync(resultPath)) {
                    try {
                        const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
                        result.data = data;
                        fs.unlinkSync(resultPath);
                        break;
                    } catch (e) {
                        console.error('❌ Failed to parse Spark result JSON:', e);
                    }
                }
            }

            resolve(result);
        });
    });
}

module.exports = { submitSparkJob };
