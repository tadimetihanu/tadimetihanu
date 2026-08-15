// app/api/chat-pdf/route.js
"use server";
import { NextResponse } from "next/server";
import pdfParse from "pdf-parse";

export async function POST(request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const question = form.get("question")?.toString() ?? "";

    if (!file) {
      return NextResponse.json({ error: "PDF file is required" }, { status: 400 });
    }

    // Enforce 10 MB limit
    const maxSize = 10 * 1024 * 1024; // 10 MB
    if (file.size > maxSize) {
      return NextResponse.json({ error: `PDF exceeds maximum size of 10 MB` }, { status: 413 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OPENAI_API_KEY not set" }, { status: 500 });
    }

    // Read file into buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extract text from PDF
    const pdfData = await pdfParse(buffer);
    const rawText = pdfData.text.trim();

    // Summarize if text is large (approx > 3000 characters)
    let contentForModel = rawText;
    if (rawText.length > 3000) {
      const summaryResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4-turbo",
          temperature: 0.3,
          messages: [
            { role: "system", content: "Summarize the following document concisely, preserving key facts and numbers." },
            { role: "user", content: rawText },
          ],
        }),
      });
      if (!summaryResp.ok) {
        const err = await summaryResp.text();
        return NextResponse.json({ error: "Failed to summarize PDF", details: err }, { status: summaryResp.status });
      }
      const summaryData = await summaryResp.json();
      contentForModel = summaryData.choices?.[0]?.message?.content ?? rawText;
    }

    // Build messages for answering the question
    const messages = [
      { role: "system", content: "You are a helpful assistant that answers questions based on the content of an uploaded PDF. Use the provided document text to formulate a concise answer." },
      { role: "system", content: contentForModel },
      { role: "user", content: question },
    ];

    const answerResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4-turbo",
        temperature: 0.7,
        messages,
      }),
    });

    if (!answerResp.ok) {
      const err = await answerResp.text();
      return NextResponse.json({ error: "OpenAI request failed", details: err }, { status: answerResp.status });
    }

    const answerData = await answerResp.json();
    const answer = answerData.choices?.[0]?.message?.content ?? "";
    return NextResponse.json({ answer });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

