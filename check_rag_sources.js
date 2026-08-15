require('dotenv').config();
const { runRagEngine } = require('./src/services/rag');
runRagEngine('list_sources', 'none').then(console.log).catch(console.error);
