// app/query-based-usecase/page.js
export const metadata = {
  title: "Query‑Based Use Cases – CloudObjectIQ",
  description: "Sample SQL queries that illustrate how to query multi‑cloud data lakes for each industry."
};

export default function QueryBasedUseCase() {
  return (
    <section className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4">
      <h1 className="text-4xl font-bold text-center mb-8 text-gray-900 dark:text-gray-100">
        Query‑Based Use Cases
      </h1>
      <div className="max-w-5xl mx-auto grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* Financial Services */}
        <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow">
          <h3 className="text-xl font-semibold mb-2 text-gray-800 dark:text-gray-100">Financial Services</h3>
          <p className="text-gray-600 dark:text-gray-300 mb-2">Fast compliance reporting across multi‑cloud data lakes.</p>
          <pre className="whitespace-pre-wrap font-mono text-sm bg-gray-100 dark:bg-gray-700 p-2 rounded">
SELECT account_id, transaction_amount, transaction_date
FROM s3.finance.transactions
WHERE transaction_date &gt;= '2023-01-01'
  AND compliance_flag = FALSE;
          </pre>
        </div>
        {/* Insurance */}
        <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow">
          <h3 className="text-xl font-semibold mb-2 text-gray-800 dark:text-gray-100">Insurance</h3>
          <p className="text-gray-600 dark:text-gray-300 mb-2">Risk analysis on raw claim data without ETL.</p>
          <pre className="whitespace-pre-wrap font-mono text-sm bg-gray-100 dark:bg-gray-700 p-2 rounded">
SELECT claim_id, severity, claim_date
FROM adls.insurance.claims
WHERE claim_date &gt;= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
  AND severity &gt;= 3;
          </pre>
        </div>
        {/* Manufacturing */}
        <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow">
          <h3 className="text-xl font-semibold mb-2 text-gray-800 dark:text-gray-100">Manufacturing</h3>
          <p className="text-gray-600 dark:text-gray-300 mb-2">IoT sensor data aggregation across clouds.</p>
          <pre className="whitespace-pre-wrap font-mono text-sm bg-gray-100 dark:bg-gray-700 p-2 rounded">
SELECT sensor_id, AVG(temperature) AS avg_temp, DATE(ts) AS day
FROM minio.manufacturing.sensors
WHERE ts &gt;= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
GROUP BY sensor_id, day;
          </pre>
        </div>
        {/* Retail */}
        <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow">
          <h3 className="text-xl font-semibold mb-2 text-gray-800 dark:text-gray-100">Retail</h3>
          <p className="text-gray-600 dark:text-gray-300 mb-2">Real‑time inventory and sales insights.</p>
          <pre className="whitespace-pre-wrap font-mono text-sm bg-gray-100 dark:bg-gray-700 p-2 rounded">
SELECT product_id, SUM(quantity) AS units_sold, CURRENT_DATE() AS report_date
FROM s3.retail.sales
WHERE sale_timestamp &gt;= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
GROUP BY product_id;
          </pre>
        </div>
        {/* Healthcare */}
        <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow">
          <h3 className="text-xl font-semibold mb-2 text-gray-800 dark:text-gray-100">Healthcare</h3>
          <p className="text-gray-600 dark:text-gray-300 mb-2">Secure analytics on patient data across clouds.</p>
          <pre className="whitespace-pre-wrap font-mono text-sm bg-gray-100 dark:bg-gray-700 p-2 rounded">
SELECT patient_id, AVG(blood_pressure) AS avg_bp, DATE(measure_time) AS day
FROM adls.healthcare.vitals
WHERE measure_time &gt;= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
GROUP BY patient_id, day;
          </pre>
        </div>
      </div>
    </section>
  );
}
