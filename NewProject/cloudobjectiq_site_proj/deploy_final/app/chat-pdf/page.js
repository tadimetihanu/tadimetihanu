// app/chat-pdf/page.js
export const metadata = {
  title: "Chat with PDF – CloudObjectIQ",
  description: "Upload a PDF and ask questions powered by OpenAI GPT‑4‑Turbo."
};

import ChatPDF from "../../components/ChatPDF/ChatPDF";

export default function ChatPdfPage() {
  return <ChatPDF />;
}
