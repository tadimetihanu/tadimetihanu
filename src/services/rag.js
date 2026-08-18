const { spawn } = require('child_process');
const path = require('path');

// Use python3 on Linux/Render and python on Windows
const pythonCmd = process.env.PYTHON_CMD || (process.platform === 'win32' ? 'python' : 'python3');

function runRagEngine(action, payload, mode = 'hybrid', sourceName = null, password = null) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, 'rag_engine.py');
        const args = [scriptPath, action, payload, mode, sourceName || "None"];
        if (password) args.push(password);
        const pythonProcess = spawn(pythonCmd, args);
        
        let output = '';
        let errorOutput = '';

        pythonProcess.stdout.on('data', (data) => {
            output += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        pythonProcess.on('close', (code) => {
            if (code !== 0) {
                console.error(`❌ [RAG-Engine] Failed (Code ${code})`);
                console.error(`   STDERR: ${errorOutput}`);
                return reject(new Error(errorOutput || 'RAG Engine failed'));
            }
            
            try {
                const lines = output.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                const result = JSON.parse(lastLine);
                resolve(result);
            } catch (e) {
                console.error('❌ Failed to parse RAG JSON:', e, output);
                reject(new Error('Invalid JSON from RAG engine'));
            }
        });

        pythonProcess.on('error', (err) => {
            reject(new Error(`Failed to start python process: ${err.message}`));
        });
    });
}

function runLegalRagEngine(action, payload, extraArg = null) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, 'legal_rag_engine.py');
        const args = [scriptPath, action, payload];
        if (extraArg) args.push(extraArg);
        const pythonProcess = spawn(pythonCmd, args);
        
        let output = '';
        let errorOutput = '';

        pythonProcess.stdout.on('data', (data) => {
            output += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        pythonProcess.on('close', (code) => {
            if (code !== 0) {
                console.error(`❌ [Legal-RAG-Engine] Failed (Code ${code})`);
                console.error(`   STDERR: ${errorOutput}`);
                return reject(new Error(errorOutput || 'Legal RAG Engine failed'));
            }
            
            try {
                const lines = output.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                const result = JSON.parse(lastLine);
                resolve(result);
            } catch (e) {
                console.error('❌ Failed to parse Legal RAG JSON:', e, output);
                reject(new Error('Invalid JSON from Legal RAG engine'));
            }
        });

        pythonProcess.on('error', (err) => {
            reject(new Error(`Failed to start python process: ${err.message}`));
        });
    });
}

module.exports = { runRagEngine, runLegalRagEngine };
