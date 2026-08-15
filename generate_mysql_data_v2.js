// generate_mysql_data_v2.js
const mysql = require('mysql2/promise');

async function generate() {
    console.log("--- Native MySQL Data Generation (Port 3307) ---");
    const config = {
        host: 'localhost',
        port: 3307,
        user: 'root',
        password: 'SolixSbds4701%%',
        database: 'lumina_db'
    };

    try {
        const connection = await mysql.createConnection(config);
        console.log("✅ Logged in to MySQL Successfully!");

        // 1. Customers
        await connection.execute(`DROP TABLE IF EXISTS customers`);
        await connection.execute(`
            CREATE TABLE customers (
                id INT PRIMARY KEY,
                name VARCHAR(100),
                email VARCHAR(100),
                city VARCHAR(50)
            )
        `);
        await connection.execute(`
            INSERT INTO customers (id, name, email, city) VALUES 
            (1, 'John Doe', 'john@gmail.com', 'New York'),
            (2, 'Jane Smith', 'jane@yahoo.com', 'London'),
            (3, 'Raj Patel', 'raj@outlook.com', 'Mumbai'),
            (4, 'Yuki Tanaka', 'yuki@google.co.jp', 'Tokyo'),
            (5, 'Maria Garcia', 'maria@gmail.com', 'Madrid')
        `);

        // 2. Products
        await connection.execute(`DROP TABLE IF EXISTS products`);
        await connection.execute(`
            CREATE TABLE products (
                id INT PRIMARY KEY,
                name VARCHAR(100),
                category VARCHAR(50),
                price DECIMAL(10,2)
            )
        `);
        await connection.execute(`
            INSERT INTO products (id, name, category, price) VALUES 
            (101, 'MacBook Pro', 'Tech', 2400.00),
            (102, 'Sony Headphones', 'Tech', 350.50),
            (103, 'Leather Bag', 'Fashion', 120.00),
            (104, 'Blue Jeans', 'Fashion', 55.00),
            (105, 'Air Purifier', 'Home', 210.99)
        `);

        // 3. Transactions
        await connection.execute(`DROP TABLE IF EXISTS transactions`);
        await connection.execute(`
            CREATE TABLE transactions (
                id INT PRIMARY KEY,
                customer_id INT,
                product_id INT,
                amount DECIMAL(10,2),
                date DATE
            )
        `);
        await connection.execute(`
            INSERT INTO transactions (id, customer_id, product_id, amount, date) VALUES 
            (1001, 1, 101, 2400.00, '2026-03-01'),
            (1002, 3, 102, 350.50, '2026-03-05'),
            (1003, 5, 105, 210.99, '2026-03-10'),
            (1004, 2, 104, 55.00, '2026-03-15'),
            (1005, 4, 103, 120.00, '2026-03-20'),
            (1006, 1, 104, 55.00, '2026-03-22'),
            (1007, 3, 105, 210.99, '2026-03-24')
        `);

        console.log("🎉 SUCCESS! Sample Data generated in 'lumina_db'.");
        await connection.end();
        process.exit(0);
    } catch (err) {
        console.error("❌ MySQL Error:", err.message);
        process.exit(1);
    }
}

generate();
