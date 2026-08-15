// components/ContactForm.js
"use client";

import { useState } from "react";

export default function ContactForm() {
  const [form, setForm] = useState({
    name: "",
    company: "",
    email: "",
    useCase: "",
    recommendedSolution: "",
  });
  const [status, setStatus] = useState("");

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus("Submitting...");
    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setStatus("Thank you! We will contact you soon.");
        setForm({ name: "", company: "", email: "", useCase: "", recommendedSolution: "" });
      } else {
        setStatus("Error submitting. Please try again.");
      }
    } catch (err) {
      setStatus("Network error. Please try again.");
    }
  };

  return (
    <section className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4 flex items-center justify-center">
      <div className="max-w-xl w-full bg-white dark:bg-gray-800 p-8 rounded-lg shadow">
        <h1 className="text-3xl font-bold mb-6 text-gray-900 dark:text-gray-100 text-center">
          Contact Us
        </h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input name="name" placeholder="Name" value={form.name} onChange={handleChange} required className="w-full px-3 py-2 border rounded" />
          <input name="company" placeholder="Company" value={form.company} onChange={handleChange} required className="w-full px-3 py-2 border rounded" />
          <input name="email" type="email" placeholder="Email" value={form.email} onChange={handleChange} required className="w-full px-3 py-2 border rounded" />
          <input name="useCase" placeholder="Use Case" value={form.useCase} onChange={handleChange} className="w-full px-3 py-2 border rounded" />
          <input name="recommendedSolution" placeholder="Recommended Solution" value={form.recommendedSolution} onChange={handleChange} className="w-full px-3 py-2 border rounded" />
          <button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-2 rounded transition">
            Submit
          </button>
        </form>
        {status && <p className="mt-4 text-center text-gray-700 dark:text-gray-300">{status}</p>}
      </div>
    </section>
  );
}
