const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

const target_name = 'azureblob1';
const account_name = 'hcdp';
const account_key = 'beJ2L9vyu4TobcnuXwrJ5nGkhs/AdJiVHYzZdsUI8ZduMfOLfV2ry2JmmkvFgm08J2iVJD5scwFy+Juo5MLFJQ==';
const container = 'test';

const connectionString = `DefaultEndpointsProtocol=https;AccountName=${account_name};AccountKey=${account_key};EndpointSuffix=core.windows.net`;

db.prepare("UPDATE targets SET endpoint = ?, bucket = ? WHERE target_name = ?")
  .run(connectionString, container, target_name);

console.log('✅ UPDATED azureblob1 with user providing info');
console.log('STRING:', connectionString);
