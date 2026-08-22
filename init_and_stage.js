const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname);

async function initAndStage() {
    console.log('📦 Initializing Git repository in:', dir);
    
    if (!fs.existsSync(path.join(dir, '.git'))) {
        await git.init({ fs, dir, defaultBranch: 'main' });
        console.log('✅ Git repository initialized.');
    } else {
        console.log('ℹ️ Git repository already exists.');
    }

    // Set config
    await git.setConfig({ fs, dir, path: 'user.name', value: 'tadimetihanu' });
    await git.setConfig({ fs, dir, path: 'user.email', value: 'tadimetihanu@users.noreply.github.com' });

    // Set remote
    try {
        await git.addRemote({ fs, dir, remote: 'origin', url: 'https://github.com/tadimetihanu/tadimetihanu.git', force: true });
        console.log('✅ Remote origin set to https://github.com/tadimetihanu/tadimetihanu.git');
    } catch(e) {
        console.log('Remote note:', e.message);
    }

    // Read all files except node_modules, .git, data/*.db
    function getAllFiles(dirPath, arrayOfFiles = []) {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            if (file === 'node_modules' || file === '.git' || file === '.next' || file === '.system_generated') continue;
            const fullPath = path.join(dirPath, file);
            if (fs.statSync(fullPath).isDirectory()) {
                getAllFiles(fullPath, arrayOfFiles);
            } else {
                arrayOfFiles.push(path.relative(dir, fullPath).replace(/\\/g, '/'));
            }
        }
        return arrayOfFiles;
    }

    const filesToAdd = getAllFiles(dir);
    console.log(`Staging ${filesToAdd.length} files...`);

    for (const filepath of filesToAdd) {
        await git.add({ fs, dir, filepath });
    }

    console.log('✅ All files staged.');

    const sha = await git.commit({
        fs,
        dir,
        author: {
            name: 'tadimetihanu',
            email: 'tadimetihanu@users.noreply.github.com'
        },
        message: 'Add Google Drive storage integration, DuckDB engine updates, and fix crypto imports'
    });

    console.log('✅ Commit created with SHA:', sha);
}

initAndStage().catch(console.error);
