// app/features/page.js
import FeatureCard from "../../components/FeatureCard";

export const metadata = {
  title: "Features – CloudObjectIQ",
  description: "Explore the Zero‑ETL analytics, multi‑cloud query engine, live cost monitor, cross‑cloud joins, and serverless architecture.",
};

export default function Features() {
  return (
    <section className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4">
      <h1 className="text-4xl font-bold text-center mb-8 text-gray-900 dark:text-gray-100">
        Features
      </h1>
      <div className="max-w-5xl mx-auto grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <FeatureCard title="Zero‑ETL Analytics">
          Query data directly from cloud storage without data movement.
        </FeatureCard>
        <FeatureCard title="Multi‑Cloud Query Engine">
          Seamlessly query S3, ADLS, MinIO using a unified engine.
        </FeatureCard>
        <FeatureCard title="Live Cost Monitor">
          Real‑time cost and data‑scanned metrics.
        </FeatureCard>
        <FeatureCard title="Cross‑Cloud Joins">
          JOIN across S3, ADLS, MinIO in a single SQL statement.
        </FeatureCard>
        <FeatureCard title="Serverless Architecture">
          No clusters to manage, auto‑scale with demand.
        </FeatureCard>
      </div>
    </section>
  );
}
