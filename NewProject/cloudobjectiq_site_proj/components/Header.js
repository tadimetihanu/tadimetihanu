"use client";
// components/Header.js
import { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";

export default function Header() {
  const [open, setOpen] = useState(false);

  const menuItems = [
    { href: "/", label: "Home" },
    { href: "/features", label: "Features" },
    { href: "/demo", label: "Demo" },
    { href: "/architecture", label: "Architecture" },
    { href: "/pricing", label: "Pricing" },
    { href: "/usecases", label: "Use Cases" },
    { href: "/chat-pdf", label: "Chat with PDF" },
  ];

  return (
    <header className="sticky top-0 z-50 bg-white/70 dark:bg-gray-900/70 backdrop-blur border-b border-gray-200 dark:border-gray-700 transition-colors duration-300">
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-16">
        {/* Logo */}
        <div className="flex-shrink-0 text-2xl font-bold text-gray-800 dark:text-white">
          CloudObjectIQ
        </div>
        {/* Desktop menu */}
        <div className="hidden md:flex space-x-6">
          {menuItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="relative text-gray-600 dark:text-gray-300 group"
            >
              <span className="transition-colors duration-200 group-hover:text-gray-900 dark:group-hover:text-white">
                {item.label}
              </span>
              <span className="absolute left-0 -bottom-1 w-full h-0.5 bg-gray-900 dark:bg-white scale-x-0 group-hover:scale-x-100 transition-transform origin-left duration-200" />
            </Link>
          ))}
          {/* Primary CTA */}
          <Link
            href="/contact"
            className="ml-4 px-4 py-2 bg-gray-900 text-white rounded-md hover:bg-gray-800 transition"
          >
            Book Demo
          </Link>
        </div>
        {/* Mobile hamburger */}
        <button
          className="md:hidden p-2 rounded-md text-gray-800 dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700 transition"
          onClick={() => setOpen(!open)}
          aria-label="Toggle menu"
        >
          <svg
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            {open ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
        {/* Mobile menu panel */}
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="absolute inset-x-0 top-full bg-white dark:bg-gray-900 shadow-lg md:hidden"
            >
              <div className="px-4 py-2 space-y-2">
                {menuItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="block text-gray-800 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white transition"
                    onClick={() => setOpen(false)}
                  >
                    {item.label}
                  </Link>
                ))}
                <Link
                  href="/contact"
                  className="block w-full text-center mt-2 px-4 py-2 bg-gray-900 text-white rounded-md hover:bg-gray-800 transition"
                  onClick={() => setOpen(false)}
                >
                  Book Demo
                </Link>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>
    </header>
  );
}
