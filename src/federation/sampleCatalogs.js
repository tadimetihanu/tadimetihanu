const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');
const Database = require('better-sqlite3');

/**
 * Generates deterministic multi-source datasets across AWS S3, Azure ADLS Gen2, MinIO,
 * PostgreSQL, MySQL, and Apache Iceberg v2 tables so that federated queries across
 * 2, 3, and 5+ catalogs execute against real physical files and relational tables.
 */
async function ensureFederationSampleData() {
    const baseDir = path.join(process.cwd(), 'data', 'federation_sources');
    const markerFile = path.join(baseDir, '.seeded_v2');
    if (fs.existsSync(markerFile)) {
        return { baseDir, seeded: false };
    }

    fs.mkdirSync(baseDir, { recursive: true });

    // Create directory structure for object storage catalogs
    const dirs = [
        path.join(baseDir, 'azure_sales', 'sales'),
        path.join(baseDir, 'aws_customers', 'crm'),
        path.join(baseDir, 'aws_customers', 'iceberg', 'customer_events.iceberg', 'data'),
        path.join(baseDir, 'aws_customers', 'iceberg', 'customer_events.iceberg', 'metadata'),
        path.join(baseDir, 'minio_products', 'catalog'),
        path.join(baseDir, 'pg_crm'),
        path.join(baseDir, 'mysql_erp')
    ];
    for (const d of dirs) {
        fs.mkdirSync(d, { recursive: true });
    }

    const duck = new duckdb.Database(':memory:');
    const runDuck = (sql) =>
        new Promise((resolve, reject) => {
            duck.run(sql, (err) => (err ? reject(err) : resolve()));
        });

    // 1. AWS S3 Catalog (`aws_customers.crm.customers`) - 10 customers (includes NULL country edge case on customer 10 & unreferenced customer 9)
    const customersParquet = path.join(baseDir, 'aws_customers', 'crm', 'customers.parquet').replace(/\\/g, '/');
    await runDuck(`
        COPY (
            SELECT * FROM (VALUES
                (1, 'Alice Sterling', 'alice@sterling.io', 'United States', 'Enterprise', 790, DATE '2024-02-15'),
                (2, 'Bruno Silva', 'bruno@silva.br', 'Brazil', 'SMB', 680, DATE '2024-05-10'),
                (3, 'Chika Tanaka', 'chika@tanaka.jp', 'Japan', 'Enterprise', 820, DATE '2024-01-20'),
                (4, 'Deepak Verma', 'deepak@verma.in', 'India', 'Mid-Market', 740, DATE '2024-07-04'),
                (5, 'Elena Rostova', 'elena@rostova.de', 'Germany', 'Enterprise', 805, DATE '2024-03-19'),
                (6, 'Farid Al-Mansoor', 'farid@mansoor.ae', 'United Arab Emirates', 'Enterprise', 775, DATE '2024-08-12'),
                (7, 'Grace Kim', 'grace@kim.kr', 'South Korea', 'Mid-Market', 710, DATE '2024-09-25'),
                (8, 'Hugo Laurent', 'hugo@laurent.fr', 'France', 'SMB', 660, DATE '2024-11-02'),
                (9, 'Isabella Rossi', 'isabella@rossi.it', 'Italy', 'SMB', 695, DATE '2024-12-01'),
                (10, 'NullCountry User', 'nullcountry@anon.org', NULL, 'Consumer', 600, DATE '2025-01-05')
            ) AS t(customer_id, customer_name, email, country, segment, credit_score, signup_date)
        ) TO '${customersParquet}' (FORMAT PARQUET);
    `);

    // 2. AWS S3 Apache Iceberg Table (`aws_customers.iceberg.customer_events`)
    const icebergDataFile = path.join(baseDir, 'aws_customers', 'iceberg', 'customer_events.iceberg', 'data', 'part-00000.parquet').replace(/\\/g, '/');
    await runDuck(`
        COPY (
            SELECT * FROM (VALUES
                (1001, 1, 'checkout_completed', 'web', TIMESTAMP '2025-01-15 10:12:00', 120),
                (1002, 1, 'product_viewed', 'mobile', TIMESTAMP '2025-01-16 14:20:00', 45),
                (1003, 2, 'checkout_completed', 'web', TIMESTAMP '2025-02-01 09:05:00', 95),
                (1004, 3, 'checkout_completed', 'web', TIMESTAMP '2025-02-10 18:30:00', 210),
                (1005, 4, 'checkout_completed', 'mobile', TIMESTAMP '2025-02-18 11:45:00', 80),
                (1006, 5, 'checkout_completed', 'web', TIMESTAMP '2025-03-02 16:00:00', 150),
                (1007, 6, 'support_ticket', 'portal', TIMESTAMP '2025-03-05 08:15:00', 300),
                (1008, 7, 'checkout_completed', 'mobile', TIMESTAMP '2025-03-11 21:10:00', 65)
            ) AS t(event_id, customer_id, event_type, channel, event_timestamp, duration_sec)
        ) TO '${icebergDataFile}' (FORMAT PARQUET);
    `);

    const icebergMetaFile = path.join(baseDir, 'aws_customers', 'iceberg', 'customer_events.iceberg', 'metadata', 'v1.metadata.json');
    fs.writeFileSync(
        icebergMetaFile,
        JSON.stringify(
            {
                'format-version': 2,
                'table-uuid': 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
                location: path.join(baseDir, 'aws_customers', 'iceberg', 'customer_events.iceberg').replace(/\\/g, '/'),
                'last-updated-ms': Date.now(),
                'last-column-id': 6,
                schemas: [
                    {
                        type: 'struct',
                        'schema-id': 0,
                        fields: [
                            { id: 1, name: 'event_id', required: true, type: 'int' },
                            { id: 2, name: 'customer_id', required: true, type: 'int' },
                            { id: 3, name: 'event_type', required: true, type: 'string' },
                            { id: 4, name: 'channel', required: true, type: 'string' },
                            { id: 5, name: 'event_timestamp', required: true, type: 'timestamp' },
                            { id: 6, name: 'duration_sec', required: false, type: 'int' }
                        ]
                    }
                ],
                'current-schema-id': 0
            },
            null,
            2
        ),
        'utf8'
    );

    // 3. MinIO Catalog (`minio_products.catalog.products` & `promotions.json`)
    const productsParquet = path.join(baseDir, 'minio_products', 'catalog', 'products.parquet').replace(/\\/g, '/');
    await runDuck(`
        COPY (
            SELECT * FROM (VALUES
                (101, 'Quantum NVMe Array', 'Hardware', 'CloudGear', 400.00, 750.00, 501),
                (102, 'Zero-ETL Stream License', 'Software', 'DataPulse', 150.00, 500.00, 502),
                (103, 'AI Vector Accelerator', 'Hardware', 'TensorCore', 600.00, 1200.00, 501),
                (104, 'Lakehouse Governance Suite', 'Software', 'SecuLake', 100.00, 350.00, 503),
                (105, 'Optical Interconnect 400G', 'Networking', 'PhotonNet', 220.00, 450.00, 504),
                (106, 'Legacy Tape Archive Unit', 'Storage', 'VaultSys', 300.00, 550.00, 505)
            ) AS t(product_id, product_name, category, brand, cost_price, list_price, supplier_id)
        ) TO '${productsParquet}' (FORMAT PARQUET);
    `);

    const promotionsJson = path.join(baseDir, 'minio_products', 'catalog', 'promotions.json');
    fs.writeFileSync(
        promotionsJson,
        JSON.stringify([
            { promo_id: 1, product_id: 101, promo_code: 'NVME2025', discount_pct: 10.0, active: true },
            { promo_id: 2, product_id: 102, promo_code: 'ZEROETL', discount_pct: 15.0, active: true },
            { promo_id: 3, product_id: 103, promo_code: 'AIBOOST', discount_pct: 5.0, active: true },
            { promo_id: 4, product_id: 104, promo_code: 'GOV2025', discount_pct: 12.5, active: false }
        ]),
        'utf8'
    );

    // 4. Azure ADLS Gen2 Catalog (`azure_sales.sales.orders` & `returns.csv`)
    // Includes 2024 and 2025 orders, duplicate order lines, and a NULL customer_id row (order 5012) to test INNER/LEFT/RIGHT/FULL joins & NULL handling
    const ordersParquet = path.join(baseDir, 'azure_sales', 'sales', 'orders.parquet').replace(/\\/g, '/');
    await runDuck(`
        COPY (
            SELECT * FROM (VALUES
                (5001, 1, 101, 10, 2, 750.00, 0.05, 'completed', DATE '2025-01-10', 'NA-East'),
                (5002, 1, 102, 10, 4, 500.00, 0.10, 'completed', DATE '2025-01-15', 'NA-East'),
                (5003, 2, 102, 20, 3, 500.00, 0.00, 'completed', DATE '2025-02-01', 'LATAM'),
                (5004, 3, 103, 30, 5, 1200.00, 0.10, 'completed', DATE '2025-02-10', 'APAC'),
                (5005, 4, 104, 30, 6, 350.00, 0.00, 'completed', DATE '2025-02-18', 'APAC'),
                (5006, 5, 101, 40, 3, 750.00, 0.05, 'completed', DATE '2025-03-02', 'EMEA'),
                (5007, 5, 105, 40, 2, 450.00, 0.00, 'completed', DATE '2025-03-04', 'EMEA'),
                (5008, 6, 103, 40, 1, 1200.00, 0.00, 'completed', DATE '2025-03-05', 'MEA'),
                (5009, 7, 104, 30, 4, 350.00, 0.05, 'completed', DATE '2025-03-11', 'APAC'),
                (5010, 8, 105, 40, 2, 450.00, 0.00, 'pending', DATE '2025-03-14', 'EMEA'),
                (5011, 1, 103, 10, 1, 1200.00, 0.00, 'completed', DATE '2024-11-20', 'NA-East'),
                (5012, NULL, 101, 10, 1, 750.00, 0.00, 'orphan_guest', DATE '2025-03-20', 'NA-West'),
                (5013, 10, 102, 10, 2, 500.00, 0.00, 'completed', DATE '2025-03-22', 'NA-West')
            ) AS t(order_id, customer_id, product_id, warehouse_id, quantity, unit_price, discount, order_status, order_date, sales_region)
        ) TO '${ordersParquet}' (FORMAT PARQUET);
    `);

    const returnsCsv = path.join(baseDir, 'azure_sales', 'sales', 'returns.csv');
    fs.writeFileSync(
        returnsCsv,
        [
            'return_id,order_id,reason,refund_amount,return_date',
            '901,5002,License Seat Adjustment,500.00,2025-01-22',
            '902,5006,Damaged Transit Packaging,750.00,2025-03-09',
            '903,5010,Customer Cancelled,900.00,2025-03-16'
        ].join('\n'),
        'utf8'
    );

    // 5. PostgreSQL Relational Catalog (`pg_crm.public.customers` & `pg_crm.public.account_managers`)
    const pgCustomersParquet = path.join(baseDir, 'pg_crm', 'public_customers.parquet').replace(/\\/g, '/');
    const pgManagersParquet = path.join(baseDir, 'pg_crm', 'public_account_managers.parquet').replace(/\\/g, '/');
    await runDuck(`
        COPY (
            SELECT * FROM (VALUES
                (1, 'Alice Sterling', 'United States', 'Enterprise', 1001, 250000.00),
                (2, 'Bruno Silva', 'Brazil', 'SMB', 1002, 45000.00),
                (3, 'Chika Tanaka', 'Japan', 'Enterprise', 1003, 380000.00),
                (4, 'Deepak Verma', 'India', 'Mid-Market', 1003, 95000.00),
                (5, 'Elena Rostova', 'Germany', 'Enterprise', 1004, 310000.00),
                (6, 'Farid Al-Mansoor', 'United Arab Emirates', 'Enterprise', 1004, 420000.00),
                (7, 'Grace Kim', 'South Korea', 'Mid-Market', 1003, 115000.00),
                (8, 'Hugo Laurent', 'France', 'SMB', 1004, 52000.00),
                (9, 'Isabella Rossi', 'Italy', 'SMB', 1004, 48000.00),
                (10, 'NullCountry User', NULL, 'Consumer', 1001, 12000.00)
            ) AS t(customer_id, customer_name, country, tier, manager_id, credit_limit)
        ) TO '${pgCustomersParquet}' (FORMAT PARQUET);
    `);

    await runDuck(`
        COPY (
            SELECT * FROM (VALUES
                (1001, 'Sarah Jenkins', 'Americas North', 's.jenkins@cloudobjectiq.com', 1200000.00),
                (1002, 'Carlos Mendez', 'LATAM', 'c.mendez@cloudobjectiq.com', 800000.00),
                (1003, 'Kenji Sato', 'APAC', 'k.sato@cloudobjectiq.com', 1500000.00),
                (1004, 'Astrid Lindqvist', 'EMEA & MEA', 'a.lindqvist@cloudobjectiq.com', 1400000.00)
            ) AS t(manager_id, manager_name, territory, manager_email, quota_usd)
        ) TO '${pgManagersParquet}' (FORMAT PARQUET);
    `);

    const pgSqlitePath = path.join(baseDir, 'pg_crm', 'relational.sqlite');
    if (fs.existsSync(pgSqlitePath)) fs.unlinkSync(pgSqlitePath);
    const pgSqlite = new Database(pgSqlitePath);
    pgSqlite.exec(`
        CREATE TABLE __fed_tables (
            schema_name TEXT,
            table_name TEXT,
            sqlite_table TEXT,
            parquet_bridge_path TEXT,
            row_count INTEGER,
            size_bytes INTEGER
        );
        CREATE TABLE public_customers (
            customer_id INTEGER PRIMARY KEY,
            customer_name TEXT,
            country TEXT,
            tier TEXT,
            manager_id INTEGER,
            credit_limit REAL
        );
        CREATE TABLE public_account_managers (
            manager_id INTEGER PRIMARY KEY,
            manager_name TEXT,
            territory TEXT,
            manager_email TEXT,
            quota_usd REAL
        );
    `);
    pgSqlite.prepare(`INSERT INTO __fed_tables VALUES (?, ?, ?, ?, ?, ?)`).run(
        'public',
        'customers',
        'public_customers',
        pgCustomersParquet,
        10,
        fs.statSync(pgCustomersParquet).size
    );
    pgSqlite.prepare(`INSERT INTO __fed_tables VALUES (?, ?, ?, ?, ?, ?)`).run(
        'public',
        'account_managers',
        'public_account_managers',
        pgManagersParquet,
        4,
        fs.statSync(pgManagersParquet).size
    );
    pgSqlite.close();

    // 6. MySQL Relational Catalog (`mysql_erp.inventory.stock` & `mysql_erp.inventory.warehouses`)
    const mysqlStockParquet = path.join(baseDir, 'mysql_erp', 'inventory_stock.parquet').replace(/\\/g, '/');
    const mysqlWarehousesParquet = path.join(baseDir, 'mysql_erp', 'inventory_warehouses.parquet').replace(/\\/g, '/');
    await runDuck(`
        COPY (
            SELECT * FROM (VALUES
                (101, 10, 140, 20, '2025-03-01'),
                (102, 10, 999, 50, '2025-03-01'),
                (102, 20, 500, 25, '2025-03-01'),
                (103, 30, 85, 15, '2025-03-01'),
                (104, 30, 450, 30, '2025-03-01'),
                (101, 40, 110, 20, '2025-03-01'),
                (105, 40, 260, 40, '2025-03-01'),
                (106, 50, 0, 10, '2025-03-01')
            ) AS t(product_id, warehouse_id, stock_on_hand, reorder_level, last_audit_date)
        ) TO '${mysqlStockParquet}' (FORMAT PARQUET);
    `);

    await runDuck(`
        COPY (
            SELECT * FROM (VALUES
                (10, 'Virginia Ashburn Hub', 'United States', 'Tier-1'),
                (20, 'Sao Paulo Logistics Hub', 'Brazil', 'Tier-2'),
                (30, 'Tokyo Narita Fulfillment', 'Japan', 'Tier-1'),
                (40, 'Frankfurt Central Depot', 'Germany', 'Tier-1'),
                (50, 'Sydney Harbor Warehouse', 'Australia', 'Tier-2')
            ) AS t(warehouse_id, warehouse_name, country_location, facility_tier)
        ) TO '${mysqlWarehousesParquet}' (FORMAT PARQUET);
    `);

    const mysqlSqlitePath = path.join(baseDir, 'mysql_erp', 'relational.sqlite');
    if (fs.existsSync(mysqlSqlitePath)) fs.unlinkSync(mysqlSqlitePath);
    const mysqlSqlite = new Database(mysqlSqlitePath);
    mysqlSqlite.exec(`
        CREATE TABLE __fed_tables (
            schema_name TEXT,
            table_name TEXT,
            sqlite_table TEXT,
            parquet_bridge_path TEXT,
            row_count INTEGER,
            size_bytes INTEGER
        );
        CREATE TABLE inventory_stock (
            product_id INTEGER,
            warehouse_id INTEGER,
            stock_on_hand INTEGER,
            reorder_level INTEGER,
            last_audit_date TEXT
        );
        CREATE TABLE inventory_warehouses (
            warehouse_id INTEGER PRIMARY KEY,
            warehouse_name TEXT,
            country_location TEXT,
            facility_tier TEXT
        );
    `);
    mysqlSqlite.prepare(`INSERT INTO __fed_tables VALUES (?, ?, ?, ?, ?, ?)`).run(
        'inventory',
        'stock',
        'inventory_stock',
        mysqlStockParquet,
        8,
        fs.statSync(mysqlStockParquet).size
    );
    mysqlSqlite.prepare(`INSERT INTO __fed_tables VALUES (?, ?, ?, ?, ?, ?)`).run(
        'inventory',
        'warehouses',
        'inventory_warehouses',
        mysqlWarehousesParquet,
        5,
        fs.statSync(mysqlWarehousesParquet).size
    );
    mysqlSqlite.close();

    await new Promise((resolve) => duck.close(() => resolve()));
    fs.writeFileSync(markerFile, new Date().toISOString(), 'utf8');
    return { baseDir, seeded: true };
}

module.exports = { ensureFederationSampleData };

