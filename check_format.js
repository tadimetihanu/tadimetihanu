const { BlobServiceClient } = require('@azure/storage-blob');
const fs = require('fs');

async function download() {
    try {
        const connStr = "DefaultEndpointsProtocol=https;AccountName=datainseek;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=core.windows.net";
        const blobService = BlobServiceClient.fromConnectionString(connStr);
        const container = blobService.getContainerClient('inseekdata');
        const blockBlob = container.getBlockBlobClient('orcdata/part-00000-43c63acf-d5c6-4101-b40b-7a0536d295a2-c000.snappy.orc');
        
        console.log('Downloading...');
        const buf = await blockBlob.downloadToBuffer();
        fs.writeFileSync('test_orc_data.dat', buf);
        console.log('Downloaded size:', buf.length);
        
        // Check magic number
        const magic = buf.slice(0, 3).toString();
        console.log('Magic Number:', magic);
        if (magic === 'ORC') console.log('This IS an ORC file.');
        else if (buf.slice(0, 4).toString() === 'PAR1') console.log('This IS a Parquet file!');
        else console.log('UNKNOWN FORMAT');
    } catch (err) {
        console.error(err.message);
    }
}

download();
