// app/queries/page.js
import Image from "next/image";

export const metadata = {
  title: "Query Screens – CloudObjectIQ",
  description: "LED‑style query examples for ADLS, AWS S3, and MinIO.",
};

export default function Queries() {
  return (
    <section className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4 flex flex-col items-center">
      <h1 className="text-4xl font-bold mb-8 text-gray-900 dark:text-gray-100 text-center">
        Query Screens
      </h1>
      <div className="grid gap-8 md:grid-cols-3 max-w-6xl w-full">
        {/* ADLS Query */}
        <div className="bg-gray-800 text-green-400 rounded-lg p-6 shadow-lg">
          <h2 className="text-2xl font-semibold mb-4 text-center">ADLS Query</h2>
          <pre className="whitespace-pre-wrap font-mono text-sm">
SELECT * FROM adls.sales WHERE date &gt;= '2023-01-01';
          </pre>
        </div>
        {/* AWS S3 Query */}
        <div className="bg-gray-800 text-green-400 rounded-lg p-6 shadow-lg">
          <h2 className="text-2xl font-semibold mb-4 text-center">AWS S3 Query</h2>
          <pre className="whitespace-pre-wrap font-mono text-sm">
SELECT * FROM s3.orders WHERE status = 'completed';
          </pre>
        </div>
        {/* MinIO Query */}
        <div className="bg-gray-800 text-green-400 rounded-lg p-6 shadow-lg">
          <h2 className="text-2xl font-semibold mb-4 text-center">MinIO Query</h2>
          <pre className="whitespace-pre-wrap font-mono text-sm">
SELECT COUNT(*) FROM minio.events WHERE event_type = 'click';
          </pre>
        </div>
      </div>
    </section>
  );
}
