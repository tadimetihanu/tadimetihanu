// app/architecture/page.js
import Image from "next/image";

export const metadata = {
  title: "Architecture – CloudObjectIQ",
  description: "Learn how CloudObjectIQ routes queries between the user, cloud storage, and compute engines (DuckDB, Spark).",
};

export default function Architecture() {
  return (
    <section className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4 flex flex-col items-center">
      <h1 className="text-4xl font-bold mb-8 text-gray-900 dark:text-gray-100 text-center">
        Architecture
      </h1>
      <div className="max-w-4xl w-full">
        <Image
          src="/architecture.png"
          alt="CloudObjectIQ architecture diagram"
          width={1200}
          height={800}
          className="rounded-lg shadow-lg"
          priority
        />
        <p className="mt-6 text-lg text-gray-700 dark:text-gray-300 text-center">
          CloudObjectIQ sits between the user and cloud storage, routing queries to the appropriate engine.
          <br /><br />
          <code className="bg-gray-200 dark:bg-gray-800 p-1 rounded">User → CloudObjectIQ →</code>
          <br />
          <code className="bg-gray-200 dark:bg-gray-800 p-1 rounded"> ├─ S3</code>
          <br />
          <code className="bg-gray-200 dark:bg-gray-800 p-1 rounded"> ├─ ADLS</code>
          <br />
          <code className="bg-gray-200 dark:bg-gray-800 p-1 rounded"> └─ MinIO → DuckDB / Spark → Query Results</code>
        </p>
      </div>
    </section>
  );
}
