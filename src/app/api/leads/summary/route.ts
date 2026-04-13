import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { transcripts, dealerName, shopName, location } = await req.json();

  if (!transcripts) {
    return NextResponse.json({ summary: null });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY_FOR_SUMMARY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `You are analyzing sales call transcripts between Vikram (sales agent from iTarang Technologies) and a dealer named ${dealerName || "the dealer"} from ${shopName || "their shop"} in ${location || "an unknown location"}.

Here are all the call transcripts in chronological order:

${transcripts}

Write a concise overall summary (4-6 sentences) of the entire conversation history. Cover:
- What has been discussed across all calls
- The dealer's interest level and any concerns raised
- Where things currently stand
- What would be the logical next step

Be direct and factual. Write in third person. Plain paragraph only, no bullet points. Always write a complete, finished paragraph — do not cut off mid-sentence.`,
              },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: 2024, // increased from 300
          temperature: 0.3,
        },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("[GEMINI] summary error:", err);
    return NextResponse.json({ summary: null });
  }

  const data = await res.json();
  const summary = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;

  return NextResponse.json({ summary });
}