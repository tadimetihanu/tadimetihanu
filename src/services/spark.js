const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Spark Job Submission Service
 * Handles executing spark-submit commands from the CloudObjectIQ dashboard.
 */
function submitSparkJob(params) {
    return new Promise((resolve, reject) => {
        const { master, deployMode, className, jarPath, conf, args } = params;

        // 🐳 Reroute through Docker since spark-submit isn't on host PATH
        // 💡 Translate 'localhost' to 'spark-master' because we are now running INSIDE the container network
        const dockerMaster = (master || 'spark://spark-master:7077')
            .replace('localhost', 'spark-master')
            .replace('127.0.0.1', 'spark-master');

        const finalJarPath = jarPath.replace(/^s3:\/\//, 's3a://');
        
        const dockerArgs = [
            'exec',
            '-u', 'root',
            'spark-master',
            '/opt/spark/bin/spark-submit',
            '--master', dockerMaster,
            '--deploy-mode', deployMode || 'client',
            '--conf', 'spark.driver.host=spark-master'
        ];

        if (className) {
            dockerArgs.push('--class', className);
        }

        // Add standard packages for Azure and AWS
        dockerArgs.push('--packages', 'org.apache.hadoop:hadoop-azure:3.3.4,com.microsoft.azure:azure-storage:8.6.6,org.apache.hadoop:hadoop-aws:3.3.4,com.amazonaws:aws-java-sdk-bundle:1.12.262');

        // Add configurations
        if (conf) {
            Object.entries(conf).forEach(([k, v]) => {
                dockerArgs.push('--conf', `${k}=${v}`);
            });
        }

        // Script path
        dockerArgs.push(finalJarPath);
        
        // Handle arguments properly (flattening space-delimited strings in arrays)
        if (args) {
            let rawArgs = [];
            
            // If it's an array of strings, some strings might contain multiple arguments (sh-style)
            if (Array.isArray(args)) {
                rawArgs = args.flatMap(a => {
                    if (typeof a !== 'string') return [a];
                    // Regex helps split by space while keeping quoted strings together (supports escaped quotes)
                    return a.match(/(?:[^\s"]+|"(?:\\.|[^"\\])*")+/gs) || [a];
                });
            } else {
                rawArgs = args.match(/(?:[^\s"]+|"(?:\\.|[^"\\])*")+/gs) || [];
            }

            rawArgs.forEach(a => {
                if (typeof a !== 'string') {
                    dockerArgs.push(String(a));
                    return;
                }
                
                let clean = a.trim();
                // Strip redundant shell quotes
                if (clean.startsWith('"') && clean.endsWith('"')) clean = clean.substring(1, clean.length - 1);
                if (clean.startsWith("'") && clean.endsWith("'")) clean = clean.substring(1, clean.length - 1);
                
                dockerArgs.push(clean.replace(/^s3:\/\//, 's3a://'));
            });
        }

        console.log(`🚀 [Spark-Wrapper] Executing: docker ${dockerArgs.join(' ')}`);

        const sparkProcess = spawn('docker', dockerArgs);
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

        sparkProcess.on('close', (code) => {
            if (code !== 0) {
                console.error(`❌ Spark job failed with exit code ${code}`);
                return resolve({
                    success: false,
                    message: `Spark job failed with exit code ${code}`,
                    output: errorData,
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
            
            // Try to read the exported results for the UI table if it exists
            const resultPath = path.join(process.cwd(), 'data', 'spark_result.json');
            if (fs.existsSync(resultPath)) {
                try {
                    const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
                    result.data = data;
                    fs.unlinkSync(resultPath);
                } catch (e) {
                    console.error('❌ Failed to parse Spark result JSON:', e);
                }
            }

            resolve(result);
        });
    });
}

module.exports = { submitSparkJob };
