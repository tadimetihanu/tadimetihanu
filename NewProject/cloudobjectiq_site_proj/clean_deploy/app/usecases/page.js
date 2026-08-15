// app/usecases/page.js
export const metadata = {
  title: "Use Cases – CloudObjectIQ",
  description: "Explore industry‑specific use cases for CloudObjectIQ.",
};

export default function UseCases() {
  return (
    <section className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4">
      <h1 className="text-4xl font-bold text-center mb-8 text-gray-900 dark:text-gray-100">
        Use Cases
      </h1>
      <div className="max-w-5xl mx-auto grid gap-6 md:grid-cols-2 lg:grid-cols-3">

        <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow">
          <h3 className="text-xl font-semibold mb-2 text-gray-800 dark:text-gray-100">Financial Services</h3>
          <p className="text-gray-600 dark:text-gray-300">Fast compliance reporting across multi‑cloud data lakes.</p>
          <ul className="list-disc list-inside text-gray-600 dark:text-gray-300 mt-2">
            <li>Regulatory reporting for AML/KYC.</li>
            <li>Real‑time fraud detection dashboards.</li>
            <li>Cross‑border transaction analytics.</li>
          </ul>
        </div>
        <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow">
          <h3 className="text-xl font-semibold mb-2 text-gray-800 dark:text-gray-100">Insurance</h3>
          <p className="text-gray-600 dark:text-gray-300">Risk analysis on raw claim data without ETL.</p>
          <ul className="list-disc list-inside text-gray-600 dark:text-gray-300 mt-2">
            <li>Claim severity clustering.</li>
            <li>Policy pricing based on real‑time actuarial models.</li>
            <li>Geospatial loss exposure mapping.</li>
          </ul>
        </div>
        <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow">
          <h3 className="text-xl font-semibold mb-2 text-gray-800 dark:text-gray-100">Manufacturing</h3>
          <p className="text-gray-600 dark:text-gray-300">IoT sensor data aggregation across clouds.</p>
          <ul className="list-disc list-inside text-gray-600 dark:text-gray-300 mt-2">
            <li>Predictive maintenance alerts.</li>
            <li>Production line efficiency tracking.</li>
            <li>Supply‑chain bottleneck detection.</li>
          </ul>
        </div>
        <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow">
          <h3 className="text-xl font-semibold mb-2 text-gray-800 dark:text-gray-100">Retail</h3>
          <p className="text-gray-600 dark:text-gray-300">Real‑time inventory and sales insights.</p>
          <ul className="list-disc list-inside text-gray-600 dark:text-gray-300 mt-2">
            <li>Stock‑out prediction.</li>
            <li>Personalized product recommendation engine.</li>
            <li>Omni‑channel sales performance.</li>
          </ul>
        </div>
        <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow">
          <h3 className="text-xl font-semibold mb-2 text-gray-800 dark:text-gray-100">Healthcare</h3>
          <p className="text-gray-600 dark:text-gray-300">Secure analytics on patient data across clouds.</p>
          <ul className="list-disc list-inside text-gray-600 dark:text-gray-300 mt-2">
            <li>Population health outcome analysis.</li>
            <li>Clinical trial cohort identification.</li>
            <li>Real‑time monitoring of vital‑sign streams.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
