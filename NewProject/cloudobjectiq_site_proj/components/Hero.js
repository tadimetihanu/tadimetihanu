// components/Hero.js
"use client";
import Image from "next/image";
import { motion } from "framer-motion";

export default function Hero() {
  return (
    <section className="relative w-full h-screen flex items-center justify-center overflow-hidden">
      {/* Background image */}
      <Image
        src="/hero_background.jpg"
        alt="Cloud analytics background"
        fill
        className="object-cover brightness-75"
        priority
      />
      {/* Dark overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/60" />
      {/* Content */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="relative text-center px-4 max-w-3xl"
      >
        <h1 className="text-5xl md:text-6xl font-bold mb-6 leading-snug text-center">
  <span className="text-indigo-400">Query</span> <span className="text-purple-400">Data</span> <span className="text-pink-400">Directly</span> <span className="text-teal-400">from</span> <span className="text-orange-400">Cloud</span> <span className="text-emerald-400">Storage</span> <span className="text-rose-400">with</span> <span className="text-yellow-400">SQL</span>
</h1>
        <p className="text-xl md:text-2xl text-gray-200 mb-8 max-w-2xl mx-auto">
          Analyze Parquet, CSV, ORC files across S3, ADLS, and MinIO without ETL or infrastructure.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <a
            href="/contact"
            className="px-8 py-3 bg-white text-gray-900 rounded-full shadow-md hover:bg-gray-100 transition"
          >
            Book Demo
          </a>
          <a
            href="/demo"
            className="px-8 py-3 bg-gray-800 text-white rounded-full shadow-md hover:bg-gray-700 transition"
          >
            Try CloudObjectIQ
          </a>
        </div>
        {/* Subtle scroll indicator */}
        <motion.div
          animate={{ y: [0, 10, 0] }}
          transition={{ repeat: Infinity, duration: 2 }}
          className="mt-12 flex justify-center"
        >
          <svg className="w-6 h-6 text-white opacity-75" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </motion.div>
      </motion.div>
    </section>
  );
}
