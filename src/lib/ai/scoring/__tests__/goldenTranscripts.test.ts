import { describe, it, expect } from "vitest";
import { analyzeTranscript } from "@/lib/ai/analysis";

// Golden-transcript suite — exercises the REAL extraction (OpenAI) end-to-end,
// so it is opt-in: set RUN_GOLDEN=1 and provide OPENAI_API_KEY. Extraction is an
// LLM, so we assert score RANGES + route/status, not exact numbers. In CI
// without a key this whole block is skipped (never a red build for a missing
// secret).
const ENABLED = process.env.RUN_GOLDEN === "1" && !!process.env.OPENAI_API_KEY;

interface Golden {
  name: string;
  transcript: string;
  min: number;
  max: number;
  action?: string;
}

const GOLDENS: Golden[] = [
  {
    name: "driving brush-off (Mishra Auto Parts) — low, schedule callback",
    transcript: [
      "agent: नमस्ते sir! Priya बोल रही हूँ iTarang Technologies से। हम Trontek lithium-ion batteries supply करते हैं और driver के लिए financing भी setup करते हैं। क्या अभी दो minute बात हो सकती है?",
      "user: अभी bike चला रहा हूँ।",
      "agent: कोई बात नहीं sir, आप आराम से drive कीजिये। बाद में connect कर लूँगी। आपका दिन शुभ हो।",
    ].join("\n"),
    min: 0,
    max: 25,
    action: "schedule_call",
  },
  {
    name: "flat rejection — disqualified, stop",
    transcript: [
      "agent: नमस्ते sir, Priya from iTarang. lithium battery ke baare mein baat karni thi.",
      "user: mujhe bilkul interest nahi hai. dobara mat call karna.",
    ].join("\n"),
    min: 0,
    max: 20,
    action: "stop",
  },
  {
    name: "strong buyer with quantity — qualified/warm, high",
    transcript: [
      "agent: namaste sir, Priya from iTarang, Trontek lithium battery with EMI financing.",
      "user: haan mujhe chahiye. mere paas 20 e-rickshaw hain, sabki battery badalni hai. EMI ka kya plan hai? rate kya hai?",
      "agent: ji sir, 12 month EMI available hai. kal aapke shop pe visit fix karein?",
      "user: haan kal subah aa jao, main owner hi hoon.",
    ].join("\n"),
    min: 70,
    max: 100,
  },
];

describe.skipIf(!ENABLED)("golden transcripts (live extraction)", () => {
  for (const g of GOLDENS) {
    it(
      g.name,
      async () => {
        const r = await analyzeTranscript(g.transcript);
        expect(r.status).toBe("ok");
        if (r.status !== "ok") return;
        expect(r.intent_score).toBeGreaterThanOrEqual(g.min);
        expect(r.intent_score).toBeLessThanOrEqual(g.max);
        // breakdown must always sum to the score
        const sum = r.score_breakdown.reduce((a, c) => a + c.contribution, 0);
        expect(sum).toBe(r.intent_score);
        if (g.action) expect(r.route.action).toBe(g.action);
      },
      30_000,
    );
  }
});

// Always-on guard so the file is never an empty suite when goldens are disabled.
it("golden suite is gated on RUN_GOLDEN + OPENAI_API_KEY", () => {
  expect(typeof ENABLED).toBe("boolean");
});
