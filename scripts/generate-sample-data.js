// Generates sample .parquet files in the data/ directory using DuckDB inline VALUES
require('dotenv').config();
const duckdb = require('duckdb');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const db = new duckdb.Database(':memory:');
const conn = db.connect();

function run(sql) {
    return new Promise((resolve, reject) => {
        conn.run(sql, err => err ? reject(err) : resolve());
    });
}

async function main() {
    // iris.parquet
    await run(`COPY (
        SELECT * FROM (VALUES
            (5.1, 3.5, 1.4, 0.2, 'setosa'), (4.9, 3.0, 1.4, 0.2, 'setosa'),
            (4.7, 3.2, 1.3, 0.2, 'setosa'), (4.6, 3.1, 1.5, 0.2, 'setosa'),
            (5.0, 3.6, 1.4, 0.2, 'setosa'), (7.0, 3.2, 4.7, 1.4, 'versicolor'),
            (6.4, 3.2, 4.5, 1.5, 'versicolor'), (6.9, 3.1, 4.9, 1.5, 'versicolor'),
            (5.5, 2.3, 4.0, 1.3, 'versicolor'), (6.5, 2.8, 4.6, 1.5, 'versicolor'),
            (6.3, 3.3, 6.0, 2.5, 'virginica'), (5.8, 2.7, 5.1, 1.9, 'virginica'),
            (7.1, 3.0, 5.9, 2.1, 'virginica'), (6.3, 2.9, 5.6, 1.8, 'virginica'),
            (6.5, 3.0, 5.8, 2.2, 'virginica')
        ) t(sepal_length, sepal_width, petal_length, petal_width, species)
    ) TO '${DATA_DIR}/iris.parquet' (FORMAT PARQUET)`);
    console.log('✅ iris.parquet');

    // inventory.parquet
    await run(`COPY (
        SELECT * FROM (VALUES
            (1, 'Laptop Pro 15', 1299.99, 45), (2, 'Wireless Mouse', 29.99, 320),
            (3, 'USB-C Hub', 49.99, 210), (4, 'Mechanical Keyboard', 149.99, 87),
            (5, 'Monitor 27in', 449.99, 33), (6, 'Webcam HD', 89.99, 156),
            (7, 'Headset Pro', 199.99, 72), (8, 'Desk Lamp LED', 39.99, 410),
            (9, 'Notebook Stand', 59.99, 190), (10, 'External SSD 1TB', 109.99, 64)
        ) t(id, product, price, stock)
    ) TO '${DATA_DIR}/inventory.parquet' (FORMAT PARQUET)`);
    console.log('✅ inventory.parquet');

    // S3_sales_data.csv
    fs.writeFileSync(path.join(DATA_DIR, 'S3_sales_data.csv'),
`region,product,sales,revenue,quarter
North,Widget A,120,14400,Q1
South,Widget B,95,11400,Q1
East,Widget C,210,25200,Q1
West,Widget A,88,10560,Q1
North,Widget B,145,17400,Q2
South,Widget C,77,9240,Q2
East,Widget A,190,22800,Q2
West,Widget B,112,13440,Q2
`);
    console.log('✅ S3_sales_data.csv');

    // minio_local_census.parquet
    await run(`COPY (
        SELECT * FROM (VALUES
            (1, 'Alice', 34, 'Engineer', 95000), (2, 'Bob', 28, 'Designer', 72000),
            (3, 'Carol', 45, 'Manager', 120000), (4, 'Dave', 31, 'Analyst', 68000),
            (5, 'Eve', 27, 'Developer', 88000), (6, 'Frank', 52, 'Director', 145000),
            (7, 'Grace', 38, 'Architect', 115000), (8, 'Hank', 29, 'Intern', 42000),
            (9, 'Iris', 41, 'Engineer', 99000), (10, 'Jack', 36, 'Manager', 110000)
        ) t(id, name, age, role, salary)
    ) TO '${DATA_DIR}/minio_local_census.parquet' (FORMAT PARQUET)`);
    console.log('✅ minio_local_census.parquet');

    // high_frequency_trading_logs.parquet
    await run(`COPY (
        SELECT * FROM (VALUES
            ('2025-01-01 09:30:01', 'AAPL', 182.50, 100, 'BUY'),
            ('2025-01-01 09:30:02', 'MSFT', 375.20, 50, 'SELL'),
            ('2025-01-01 09:30:03', 'GOOG', 140.80, 200, 'BUY'),
            ('2025-01-01 09:30:04', 'AMZN', 178.90, 75, 'BUY'),
            ('2025-01-01 09:30:05', 'TSLA', 245.10, 30, 'SELL'),
            ('2025-01-01 09:30:06', 'NVDA', 620.00, 25, 'BUY'),
            ('2025-01-01 09:30:07', 'META', 505.30, 40, 'SELL'),
            ('2025-01-01 09:30:08', 'AAPL', 182.75, 150, 'SELL')
        ) t(timestamp, ticker, price, volume, side)
    ) TO '${DATA_DIR}/high_frequency_trading_logs.parquet' (FORMAT PARQUET)`);
    console.log('✅ high_frequency_trading_logs.parquet');

    // local_temp_data.csv (MinIO)
    fs.writeFileSync(path.join(DATA_DIR, 'local_temp_data.csv'),
`id,key,value,updated_at
1,cache_timeout,300,2025-03-15 08:00:00
2,max_connections,100,2025-03-15 08:00:00
3,retry_limit,3,2025-03-15 09:00:00
4,batch_size,500,2025-03-15 10:00:00
5,debug_mode,0,2025-03-15 11:00:00
`);
    console.log('✅ local_temp_data.csv');

    // global_marketing_data.parquet (Azure Blob)
    await run(`COPY (
        SELECT * FROM (VALUES
            ('2025-Q1', 'Email', 45000, 1250, 2.78), ('2025-Q1', 'Social', 120000, 3800, 3.17),
            ('2025-Q1', 'Search', 85000, 4200, 4.94), ('2025-Q1', 'Display', 200000, 1100, 0.55),
            ('2025-Q2', 'Email', 52000, 1480, 2.85), ('2025-Q2', 'Social', 135000, 4200, 3.11),
            ('2025-Q2', 'Search', 92000, 4900, 5.33), ('2025-Q2', 'Display', 180000, 980, 0.54)
        ) t(period, channel, impressions, conversions, ctr)
    ) TO '${DATA_DIR}/global_marketing_data.parquet' (FORMAT PARQUET)`);
    console.log('✅ global_marketing_data.parquet');

    // iot_telemetry_stream.json (Azure Blob)
    fs.writeFileSync(path.join(DATA_DIR, 'iot_telemetry_stream.json'),
JSON.stringify([
    { device_id: 'sensor-001', timestamp: '2025-03-15T08:00:00Z', temperature: 22.5, humidity: 61.2, status: 'ok' },
    { device_id: 'sensor-002', timestamp: '2025-03-15T08:00:05Z', temperature: 23.1, humidity: 59.8, status: 'ok' },
    { device_id: 'sensor-003', timestamp: '2025-03-15T08:00:10Z', temperature: 21.8, humidity: 63.5, status: 'warn' },
    { device_id: 'sensor-001', timestamp: '2025-03-15T08:01:00Z', temperature: 22.7, humidity: 60.9, status: 'ok' },
    { device_id: 'sensor-004', timestamp: '2025-03-15T08:01:05Z', temperature: 35.2, humidity: 45.1, status: 'alert' },
], null, 2));
    console.log('✅ iot_telemetry_stream.json');

    // annual_finance_report_2025.csv (ADLS)
    fs.writeFileSync(path.join(DATA_DIR, 'annual_finance_report_2025.csv'),
`department,budget,spent,variance,headcount,quarter
Engineering,500000,487500,12500,42,Q1
Marketing,200000,215000,-15000,18,Q1
Sales,350000,338000,12000,30,Q1
Operations,150000,148000,2000,12,Q1
Engineering,500000,502000,-2000,44,Q2
Marketing,200000,198000,2000,17,Q2
Sales,350000,365000,-15000,32,Q2
Operations,150000,141000,9000,11,Q2
`);
    console.log('✅ annual_finance_report_2025.csv');

    // gcs_raw_events.parquet (GCS)
    await run(`COPY (
        SELECT * FROM (VALUES
            ('evt_001', 'page_view', 'user_123', '/home', '2025-03-15 08:00:01'),
            ('evt_002', 'click', 'user_456', '/products', '2025-03-15 08:00:03'),
            ('evt_003', 'purchase', 'user_123', '/checkout', '2025-03-15 08:05:22'),
            ('evt_004', 'page_view', 'user_789', '/about', '2025-03-15 08:06:10'),
            ('evt_005', 'signup', 'user_999', '/register', '2025-03-15 08:07:45'),
            ('evt_006', 'click', 'user_456', '/cart', '2025-03-15 08:08:00'),
            ('evt_007', 'purchase', 'user_456', '/checkout', '2025-03-15 08:12:33'),
            ('evt_008', 'page_view', 'user_123', '/account', '2025-03-15 08:15:00')
        ) t(event_id, event_type, user_id, page, occurred_at)
    ) TO '${DATA_DIR}/gcs_raw_events.parquet' (FORMAT PARQUET)`);
    console.log('✅ gcs_raw_events.parquet');

    // user_sessions.json (GCS)
    fs.writeFileSync(path.join(DATA_DIR, 'user_sessions.json'),
JSON.stringify([
    { session_id: 'sess_001', user_id: 'user_123', start: '2025-03-15T08:00:00Z', duration_s: 920, pages: 7, converted: true },
    { session_id: 'sess_002', user_id: 'user_456', start: '2025-03-15T08:00:03Z', duration_s: 744, pages: 5, converted: true },
    { session_id: 'sess_003', user_id: 'user_789', start: '2025-03-15T08:06:10Z', duration_s: 120, pages: 2, converted: false },
    { session_id: 'sess_004', user_id: 'user_999', start: '2025-03-15T08:07:45Z', duration_s: 340, pages: 3, converted: false },
], null, 2));
    console.log('✅ user_sessions.json');

    // ml_training_set.csv (GCS)
    fs.writeFileSync(path.join(DATA_DIR, 'ml_training_set.csv'),
`feature_1,feature_2,feature_3,feature_4,feature_5,label
0.52,1.23,-0.45,0.88,2.10,1
-1.10,0.34,1.22,-0.56,0.78,0
0.91,-0.67,0.44,1.33,-0.22,1
-0.23,0.98,-1.10,0.45,1.56,0
1.44,0.12,0.89,-1.20,0.34,1
-0.78,1.55,-0.34,0.67,-1.10,0
0.33,-0.44,1.78,0.23,0.90,1
-1.22,0.77,0.12,-0.89,1.45,0
`);
    console.log('✅ ml_training_set.csv');

    // vendor_list.csv (S3 - xlsx substitute for DuckDB compatibility)
    fs.writeFileSync(path.join(DATA_DIR, 'vendor_list.csv'),
`vendor_id,company,contact,country,category,rating
V001,Acme Supplies,alice@acme.com,USA,Hardware,4.5
V002,GlobalTech,bob@globaltech.io,UK,Software,4.8
V003,FastShip Co,carol@fastship.com,Canada,Logistics,4.2
V004,DataPro,dave@datapro.net,Germany,Analytics,4.7
V005,CloudBase,eve@cloudbase.io,USA,Infrastructure,4.9
`);
    console.log('✅ vendor_list.csv');

    console.log(`\n🎉 All sample files created in: ${DATA_DIR}`);
    db.close();
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
