// components/ChatPDF/ChatPDF.js
"use client";
import { useState } from "react";

export default function ChatPDF() {
  const [file, setFile] = useState(null);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file || !question) return;
    setLoading(true);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("question", question);

    // Optimistically add user message
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setQuestion("");

    try {
      const res = await fetch("/api/chat-pdf", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", content: data.answer }]);
    } catch (err) {
      setMessages((prev) => [...prev, { role: "assistant", content: "Error: " + err.message }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12 px-4">
      <h1 className="text-3xl font-bold text-center mb-8 text-gray-900 dark:text-gray-100">
        Chat with PDF
      </h1>
      <form onSubmit={handleSubmit} className="max-w-2xl mx-auto space-y-4">
        <input
          type="file"
          accept="application/pdf"
          onChange={handleFileChange}
          className="w-full p-2 border rounded"
          required
        />
        <textarea
          placeholder="Ask a question about the PDF..."
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          className="w-full p-2 border rounded h-24"
          required
        />
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 bg-gray-900 text-white rounded hover:bg-gray-800"
        >
          {loading ? "Thinking..." : "Send"}
        </button>
      </form>
      <div className="max-w-2xl mx-auto mt-8 space-y-4">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={
              msg.role === "assistant"
                ? "bg-white dark:bg-gray-800 p-4 rounded shadow"
                : "bg-gray-200 dark:bg-gray-700 p-4 rounded"
            }
          >
            <p className="font-medium">
              {msg.role === "assistant" ? "AI" : "You"}:
            </p>
            <p>{msg.content}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
