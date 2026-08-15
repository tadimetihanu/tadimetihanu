// app/contact/page.js
export const metadata = {
  title: "Contact – CloudObjectIQ",
  description: "Get in touch, request a demo or start a free trial.",
};

import ContactForm from "../../components/ContactForm";

export default function ContactPage() {
  return <ContactForm />;
}
