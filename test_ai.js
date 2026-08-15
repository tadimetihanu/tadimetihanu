
require('dotenv').config();
const { suggestQuery } = require('./src/query/ai');

async function test() {
    const prompt = "List the top 10 cities by number of customers";
    const schema = []; // no schema for current file
    const fileName = "iris.parquet";
    const scanFn = "parquet_scan('iris.parquet')";
    const availableTables = [
        "S3_sales_data.csv",
        "annual_finance_report_2025.csv",
        "big_table_orders.parquet",
        "customers-100.csv",
        "customers_1000.csv",
        "iris.parquet"
    ];

    try {
        console.log("Testing suggestQuery...");
        const result = await suggestQuery(prompt, schema, fileName, scanFn, availableTables);
        console.log("Result:", JSON.stringify(result, null, 2));
    } catch (err) {
        console.error("Error:", err.message);
    }
}

test();
