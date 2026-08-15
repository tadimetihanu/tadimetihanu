const db = require('better-sqlite3')('./data/metadata.db');

// Fix Azure Cloud Target - actual container is datainseektech
const r1 = db.prepare("UPDATE targets SET bucket = 'datainseektech' WHERE target_name = 'Azure Cloud Target'").run();
console.log('Fixed Azure Cloud Target:', r1.changes, 'rows');

// Fix ADLS Primary Lake - update to datainseektech under datainseek account  
const r2 = db.prepare("UPDATE targets SET bucket = 'datainseektech' WHERE target_name = 'ADLS Primary Lake'").run();
console.log('Fixed ADLS Primary Lake:', r2.changes, 'rows');

// Verify all
const all = db.prepare('SELECT target_name, provider_type, bucket FROM targets').all();
console.log('\nCurrent targets:');
all.forEach(t => console.log(' ', t.target_name, '|', t.provider_type, '| bucket:', t.bucket));
