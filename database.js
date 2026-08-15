const _queryAzureBlock = `
        if (provider === 'azure') {
            const { BlobServiceClient: AzBSC } = require('@azure/storage-blob');
            const connstr   = process.env.AZURE_STORAGE_CONNECTION_STRING;
            const container = process.env.AZURE_CONTAINER || 'datainseektech';
            if (connstr) {
                const fileRefs = [...sql.matchAll(/['"]([\w/.-]+\\.(csv|parquet|json|xlsx))['"]/gi)].map(m => m[1]);
                for (const fname of fileRefs) {
                    const tmpPath = path.join(require('os').tmpdir(), 'cs_' + Date.now() + '_' + require('path').basename(fname));
                    const blob    = AzBSC.fromConnectionString(connstr).getContainerClient(container).getBlobClient(fname);
                    await blob.downloadToFile(tmpPath);
                    tempFiles.push(tmpPath);
                    const safeRe = fname.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
                    finalSql = finalSql.replace(new RegExp('[\\'"' + safeRe + '\\']', 'g'), '\\'' + tmpPath.replace(/\\\\/g, '/') + '\\'');
                }
            }
        }
`;
