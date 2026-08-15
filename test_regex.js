const connStr = "DefaultEndpointsProtocol=https;AccountName=inseeksadls;AccountKey=YOUR_AZURE_KEY;EndpointSuffix=dfs.core.windows.net";
const match = connStr.match(/AccountName=([^;]+)/i);
console.log('Match:', match ? match[1] : 'null');

const bucket = 'inseekdata';
const account = match ? match[1] : '';
const prefix = account ? `az://${account}/${bucket}/` : `az://${bucket}/`;
console.log('Generated Prefix:', prefix);
