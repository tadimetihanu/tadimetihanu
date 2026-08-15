const solr = require('solr-client');
const fs = require('fs');
require('dotenv').config();

// SOLR_URL should be like http://localhost:8983/solr/cloudobjectiq
const solrUrl = process.env.SOLR_URL || 'http://localhost:8983/solr/cloudobjectiq';
const url = new URL(solrUrl);
const client = solr.createClient({
  host: url.hostname,
  port: url.port,
  core: url.pathname.replace(/^\//, ''),
  path: '/solr'
});

/**
 * Add a document to Solr.
 * @param {Object} doc - Document with fields matching Solr schema.
 */
function addDocument(doc) {
  return new Promise((resolve, reject) => {
    client.add(doc, (err, result) => {
      if (err) return reject(err);
      client.commit((err2) => {
        if (err2) return reject(err2);
        resolve(result);
      });
    });
  });
}

/**
 * Index a file by reading its content and sending to Solr.
 * @param {string} id - Unique identifier for the document.
 * @param {string} filePath - Local absolute path to the file.
 * @param {Object} meta - Additional metadata (title, doc_type, jurisdiction, tags, source_path).
 */
async function indexFile(id, filePath, meta = {}) {
  const content = fs.readFileSync(filePath, 'utf8');
  const doc = Object.assign({
    id,
    title: meta.title || id,
    content,
    doc_type: meta.doc_type || 'file',
    jurisdiction: meta.jurisdiction || '',
    created_at: new Date().toISOString(),
    tags: meta.tags || [],
    source_path: filePath
  }, meta);
  await addDocument(doc);
}

module.exports = {
  addDocument,
  indexFile
};
