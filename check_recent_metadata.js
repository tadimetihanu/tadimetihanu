const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

try {
  const recentMetadata = db.prepare("SELECT * FROM metadata_catalog ORDER BY ROWID DESC LIMIT 3").all();
  console.log("Recent Metadata Catalog:", recentMetadata);
} catch (err) {
  console.error("Error:", err.message);
}
