import { ParsedData } from "./types";

function cleanJSON(text: string) {
  return text.replace(/```json|```/g, "").trim();
}

export async function parseTranscript(transcript: string): Promise<ParsedData> {
  const prompt = `
    Analyze this sales call transcript.
    
    Extract:
    1. outcome (interested, not_interested, callback_requested)
    2. callback_time:
       - If exact time mentioned → return ISO datetime
       - If vague (later, baad me, busy) → return "unspecified"
       - If no callback → return null
    3. language
    
    Transcript:
    ${transcript}
    
    Return ONLY JSON:
    {
      "outcome": "",
      "callback_time": "",
      "language": ""
    }
    `;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    },
  );

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  try {
    return JSON.parse(cleanJSON(text));
  } catch {
    console.error("Parser error:", text);

    return {
      outcome: "unknown",
      callback_time: null,
      language: "unknown",
    };
  }
}
