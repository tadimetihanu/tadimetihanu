// generate_sample_data.js
const { runQuery } = require('./src/query/engine');

async function generate() {
    console.log("--- Generating Premium Sample Data in Docker MySQL ---");
    const host = "localhost";
    const user = "root";
    const pass = "SolixSbds4701%%";
    const port = 3307;
    const db = "lumina_db";

    try {
        const sql = `
            INSTALL mysql; 
            LOAD mysql;
            ATTACH 'host=${host} user=${user} password=${pass} port=${port} database=${db}' AS my_db (TYPE MYSQL);

            -- 1. Create Customers Table
            CREATE TABLE IF NOT EXISTS my_db.customers (
                id INTEGER PRIMARY KEY,
                name VARCHAR(100),
                email VARCHAR(100),
                region VARCHAR(50)
            );

            INSERT INTO my_db.customers (id, name, email, region) VALUES 
            (1, 'Alice Johnson', 'alice@example.com', 'North America'),
            (2, 'Bob Smith', 'bob@example.com', 'Europe'),
            (3, 'Charlie Brown', 'charlie@example.com', 'Asia'),
            (4, 'Diana Prince', 'diana@example.com', 'South America'),
            (5, 'Ethan Hunt', 'ethan@example.com', 'Europe');

            -- 2. Create Products Table
            CREATE TABLE IF NOT EXISTS my_db.products (
                id INTEGER PRIMARY KEY,
                name VARCHAR(100),
                price DECIMAL(10, 2),
                category VARCHAR(50)
            );

            INSERT INTO my_db.products (id, name, price, category) VALUES 
            (101, 'Quantum Watch', 299.99, 'Electronics'),
            (102, 'Leather Satchel', 120.50, 'Fashion'),
            (103, 'Mechanical Keyboard', 159.00, 'Electronics'),
            (104, 'Bamboo Lamp', 45.00, 'Home Decor'),
            (105, 'Coffee Master X', 89.99, 'Kitchen');

            -- 3. Create Transactions Table
            CREATE TABLE IF NOT EXISTS my_db.transactions (
                id INTEGER PRIMARY KEY,
                customer_id INTEGER,
                product_id INTEGER,
                amount DECIMAL(10, 2),
                transaction_date DATE
            );

            INSERT INTO my_db.transactions (id, customer_id, product_id, amount, transaction_date) VALUES 
            (1001, 1, 101, 299.99, '2026-03-01'),
            (1002, 2, 102, 120.50, '2026-03-05'),
            (1003, 1, 103, 159.00, '2026-03-10'),
            (1004, 3, 104, 45.00, '2026-03-15'),
            (1005, 5, 105, 89.99, '2026-03-20'),
            (1006, 4, 101, 299.99, '2026-03-22'),
            (1007, 2, 104, 45.00, '2026-03-24');

            SELECT 'OK' as status;
        `;
        
        await runQuery(sql);
        console.log("✅ SUCCESS! 3 Tables (Customers, Products, Transactions) successfully created and populated in Docker MySQL.");
        process.exit(0);
    } catch (err) {
        console.error("❌ Data Generation Failed:", err.message);
        process.exit(1);
    }
}

generate();
