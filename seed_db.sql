CREATE DATABASE sales_db;

\c sales_db;

CREATE TABLE customers (
    customer_id SERIAL PRIMARY KEY,
    first_name VARCHAR(50) NOT NULL,
    last_name VARCHAR(50) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
    product_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    stock_quantity INT DEFAULT 0
);

CREATE TABLE orders (
    order_id SERIAL PRIMARY KEY,
    customer_id INT REFERENCES customers(customer_id),
    order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'Pending',
    total_amount DECIMAL(10, 2) NOT NULL
);

CREATE TABLE order_items (
    item_id SERIAL PRIMARY KEY,
    order_id INT REFERENCES orders(order_id),
    product_id INT REFERENCES products(product_id),
    quantity INT NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL
);

-- Insert Sample Data
INSERT INTO customers (first_name, last_name, email) VALUES
('John', 'Doe', 'john.doe@example.com'),
('Jane', 'Smith', 'jane.smith@example.com'),
('Michael', 'Johnson', 'michael.j@example.com'),
('Emily', 'Davis', 'emily.davis@example.com'),
('William', 'Brown', 'william.b@example.com');

INSERT INTO products (name, category, price, stock_quantity) VALUES
('Laptop Pro', 'Electronics', 1299.99, 50),
('Wireless Mouse', 'Accessories', 29.99, 200),
('Mechanical Keyboard', 'Accessories', 149.50, 75),
('27-inch Monitor', 'Electronics', 349.00, 30),
('Noise Cancelling Headphones', 'Audio', 199.99, 100);

INSERT INTO orders (customer_id, status, total_amount) VALUES
(1, 'Completed', 1329.98),
(2, 'Processing', 349.00),
(3, 'Completed', 199.99),
(1, 'Shipped', 149.50),
(4, 'Pending', 1299.99);

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
(1, 1, 1, 1299.99),
(1, 2, 1, 29.99),
(2, 4, 1, 349.00),
(3, 5, 1, 199.99),
(4, 3, 1, 149.50),
(5, 1, 1, 1299.99);
