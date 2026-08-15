-- Generate synthetic data and create a denormalized 'big table' Parquet file
-- Using DuckDB's generate_series and random functions

-- 1. Create Customers
CREATE TABLE customers AS
SELECT
    range AS customer_id,
    'Customer_' || range AS customer_name,
    CASE WHEN range % 2 = 0 THEN 'Segment_A' ELSE 'Segment_B' END AS segment,
    floor(random() * 100)::INT AS age
FROM range(1, 10001);

-- 2. Create Categories
CREATE TABLE categories AS
SELECT
    range AS category_id,
    'Category_' || range AS category_name
FROM range(1, 11);

-- 3. Create Products
CREATE TABLE products AS
SELECT
    range AS product_id,
    'Product_' || range AS product_name,
    (range % 10) + 1 AS category_id,
    random() * 500 AS price
FROM range(1, 1001);

-- 4. Create Orders (The Big Fact Table)
-- We'll generate 1 million rows for the "Big Table"
CREATE TABLE orders AS
SELECT
    range AS order_id,
    floor(random() * 10000 + 1)::INT AS customer_id,
    floor(random() * 1000 + 1)::INT AS product_id,
    (random() * 10 + 1)::INT AS quantity,
    current_date - (random() * 365)::INT AS order_date
FROM range(1, 1000001);

-- 5. Perform Multiple Joins to create the Big Table
-- And export directly to Parquet
COPY (
    SELECT
        o.order_id,
        o.order_date,
        o.quantity,
        c.customer_id,
        c.customer_name,
        c.segment,
        c.age,
        p.product_id,
        p.product_name,
        p.price,
        (o.quantity * p.price) AS total_amount,
        cat.category_id,
        cat.category_name
    FROM orders o
    JOIN customers c ON o.customer_id = c.customer_id
    JOIN products p ON o.product_id = p.product_id
    JOIN categories cat ON p.category_id = cat.category_id
) TO 'C:\Users\user\.gemini\antigravity\scratch\data-explorer-tool\data\big_table_orders.parquet' (FORMAT PARQUET);
