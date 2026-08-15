// app/demo/page.js
import Image from "next/image";

export const metadata = {
  title: "Demo – CloudObjectIQ",
  description: "See CloudObjectIQ in action – SQL editor, results, cost dashboard, and storage connections.",
};

export default function Demo() {
  return (
    <section className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4">
      <h1 className="text-4xl font-bold text-center mb-8 text-gray-900 dark:text-gray-100">
        Product Demo
      </h1>
      <div className="grid gap-8 md:grid-cols-2 max-w-5xl mx-auto">
        <div className="flex flex-col items-center">
          <Image
            src="/demo_dark.png"
            alt="Dark‑mode dashboard"
            width={800}
            height={450}
            className="rounded-lg shadow"
          />
          <p className="mt-2 text-center text-gray-700 dark:text-gray-300">Dark‑mode dashboard</p>
        </div>
        <div className="flex flex-col items-center">
          <Image
            src="/demo_light.png"
            alt="Light‑mode dashboard"
            width={800}
            height={450}
            className="rounded-lg shadow"
          />
          <p className="mt-2 text-center text-gray-700 dark:text-gray-300">Light‑mode dashboard</p>
        </div>
      </div>
    </section>
  );
}
