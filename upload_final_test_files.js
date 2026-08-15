const { BlobServiceClient } = require('@azure/storage-blob');
const fs = require('fs');
const solrClient = require('./services/solr_client'); // Import Solr client

const connStr = 'DefaultEndpointsProtocol=https;AccountName=hcdp;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net';
const blobService = BlobServiceClient.fromConnectionString(connStr);

async function upload(containerName, blobName, localPath) {
    console.log(`Uploading ${localPath} to ${containerName}/${blobName}...`);
    const containerClient = blobService.getContainerClient(containerName);
    const blockBlob = containerClient.getBlockBlobClient(blobName);
    const buffer = fs.readFileSync(localPath);
    await blockBlob.upload(buffer, buffer.length, {
        blobHTTPHeaders: { blobContentType: 'text/csv' }
    });
    console.log(`✅ Uploaded ${blobName} to ${containerName}`);
    // Index in Solr after successful upload
    const docId = `${containerName}_${blobName}`;
    await solrClient.indexFile(docId, localPath, {
        title: blobName,
        doc_type: 'csv',
        jurisdiction: '',
        tags: ['upload']
    });
    console.log(`✅ Indexed ${blobName} in Solr`);
}

async function run() {
    const csvPath = 'D:\\c-downloads\\supermarket_sales.csv';
    try {
        await upload('inseekdata', 'csvdata/supermarket_sales.csv', csvPath);
        await upload('datainseektech', 'ingestion_1772342036579.csv', csvPath);
        console.log('🎉 All files uploaded and indexed successfully!');
    } catch (e) {
        console.error('❌ Upload failed:', e.message);
    }
}

run();
