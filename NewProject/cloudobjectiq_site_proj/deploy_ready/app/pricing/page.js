// app/pricing/page.js
export const metadata = {
  title: "Pricing – CloudObjectIQ",
  description: "Choose the plan that fits your analytics needs.",
};

export default function Pricing() {
  return (
    <section className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4">
      <h1 className="text-4xl font-bold text-center mb-8 text-gray-900 dark:text-gray-100">
        Pricing
      </h1>
      <div className="max-w-4xl mx-auto grid gap-6 md:grid-cols-3">
        <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow">
          <h2 className="text-2xl font-semibold mb-4 text-gray-800 dark:text-gray-100">Community</h2>
          <p className="text-3xl font-bold mb-2">Free</p>
          <ul className="mb-4">
            <li>Basic analytics</li>
            <li>Limited queries</li>
          </ul>
          <button className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded">
            Sign Up
          </button>
        </div>
        <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow">
          <h2 className="text-2xl font-semibold mb-4 text-gray-800 dark:text-gray-100">Professional</h2>
          <p className="text-3xl font-bold mb-2">$99/mo</p>
          <ul className="mb-4">
            <li>Unlimited queries</li>
            <li>Live cost monitor</li>
            <li>Email support</li>
          </ul>
          <button className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded">
            Start Free Trial
          </button>
        </div>
        <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow">
          <h2 className="text-2xl font-semibold mb-4 text-gray-800 dark:text-gray-100">Enterprise</h2>
          <p className="text-3xl font-bold mb-2">Contact Sales</p>
          <ul className="mb-4">
            <li>Custom SLAs</li>
            <li>Dedicated support</li>
            <li>On‑prem options</li>
          </ul>
          <button className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded">
            Request Demo
          </button>
        </div>
      </div>
    </section>
  );
}
