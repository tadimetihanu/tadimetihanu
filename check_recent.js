const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log("Tables:", tables.map(t => t.name).join(', '));
  
  if (tables.some(t => t.name === 'targets')) {
    const recentTargets = db.prepare("SELECT * FROM targets ORDER BY ROWID DESC LIMIT 3").all();
    console.log("Recent Targets:", recentTargets);
  }
  
  if (tables.some(t => t.name === 'files')) {
    const recentFiles = db.prepare("SELECT * FROM files ORDER BY ROWID DESC LIMIT 3").all();
    console.log("Recent Files:", recentFiles);
  }
} catch (err) {
  console.error("Error:", err.message);
}
