// components/FeatureCard.js
export default function FeatureCard({ title, children }) {
  return (
    <div className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow hover:shadow-lg transition">
      <h3 className="text-xl font-semibold mb-4 text-gray-800 dark:text-gray-100">{title}</h3>
      <p className="text-gray-600 dark:text-gray-300">{children}</p>
    </div>
  );
}
