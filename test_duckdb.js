const { runQuery } = require('./src/query/engine');
runQuery("SELECT * FROM 's3://datalake/your_file_name.csv' LIMIT 1").then(console.log).catch(e => console.log(e.message));
