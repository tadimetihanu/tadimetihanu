// app/page.js
import Hero from "../components/Hero";

export const metadata = {
  title: "CloudObjectIQ – Serverless Multi‑Cloud SQL Analytics",
  description: "Query data directly from cloud storage with SQL. Zero‑ETL, multi‑cloud, serverless analytics platform.",
};

export default function Home() {
  return <Hero />;
}
