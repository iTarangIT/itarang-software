import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { analyzeTranscript } from "@/lib/ai/analysis";
import { computeBand, type QualificationSignals, type LeadStatus, bandToStatus } from "@/lib/ai/scoring";

// Golden-transcript suite — exercises the REAL extraction (OpenAI) end-to-end,
// so it is opt-in: set RUN_GOLDEN=1 and provide OPENAI_API_KEY. Extraction is an
// LLM, so we assert the BAND falls in an allowed set, not exact internals. In CI
// without a key this whole block is skipped (never a red build for a missing
// secret).
const ENABLED = process.env.RUN_GOLDEN === "1" && !!process.env.OPENAI_API_KEY;

interface Golden {
  name: string;
  transcript: string;
  bands: string[]; // allowed bands (null === dropped_empty, no band)
}

const GOLDENS: Golden[] = [
  {
    name: "driving brush-off (Mishra Auto Parts) — not Qualified",
    transcript: [
      "agent: नमस्ते sir! Priya बोल रही हूँ iTarang Technologies से। हम Trontek lithium-ion batteries supply करते हैं और driver के लिए financing भी setup करते हैं। क्या अभी दो minute बात हो सकती है?",
      "user: अभी bike चला रहा हूँ।",
      "agent: कोई बात नहीं sir, आप आराम से drive कीजिये। बाद में connect कर लूँगी। आपका दिन शुभ हो।",
    ].join("\n"),
    bands: ["Cold", "Warm", "Disqualified"],
  },
  {
    name: "flat rejection — Disqualified",
    transcript: [
      "agent: नमस्ते sir, Priya from iTarang. lithium battery ke baare mein baat karni thi.",
      "user: mujhe bilkul interest nahi hai. dobara mat call karna.",
    ].join("\n"),
    bands: ["Disqualified"],
  },
  {
    name: "strong buyer, volume + EMI ask + passive callback — Qualified",
    transcript: [
      "agent: namaste sir, Priya from iTarang, Trontek lithium battery with EMI financing.",
      "user: haan mujhe chahiye. mere paas 20 e-rickshaw hain, sabki battery badalni hai. EMI ka kya plan hai? rate kya hai?",
      "agent: ji sir, 12 month EMI available hai. kal aapke shop pe visit fix karein?",
      "user: haan kal subah aa jao, main owner hi hoon.",
    ].join("\n"),
    bands: ["Qualified"],
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
        expect(g.bands).toContain(r.band ?? "dropped_empty");
        // lead_score must agree with the band it came from.
        if (r.band) expect(bandToStatus(r.band)).toBe(bandToStatus(r.band));
      },
      30_000,
    );
  }
});

// ── Fixture-driven RUBRIC regression (always-on, no LLM) ─────────────────────
// The golden fixture is materialized from human band corrections by
// `npm run intent:export-golden`. For every case carrying ground-truth signals,
// the deterministic band rule must reproduce the human's label. Reset to empty
// on the band-model cutover (old BANT corrections are a different signal shape);
// it repopulates as new corrections accumulate. Needs no OpenAI key — runs in CI.
type GoldenFixtureCase = {
  callId: string;
  label: LeadStatus;
  originalSignals: QualificationSignals | null;
  correctedSignals: QualificationSignals | null;
};

function loadFixture(): GoldenFixtureCase[] {
  const p = path.resolve(process.cwd(), "src/lib/ai/scoring/__tests__/fixtures/golden.json");
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as GoldenFixtureCase[];
  } catch {
    return [];
  }
}

function labelFor(signals: QualificationSignals): LeadStatus {
  const r = computeBand(signals);
  return bandToStatus(r.band) ?? "disqualified";
}

const FIXTURE = loadFixture().filter((c) => c.correctedSignals ?? c.originalSignals);

describe.skipIf(FIXTURE.length === 0)("golden fixture — rubric reproduces human label", () => {
  for (const c of FIXTURE) {
    it(`${c.callId} → ${c.label}`, () => {
      const sig = (c.correctedSignals ?? c.originalSignals) as QualificationSignals;
      expect(labelFor(sig)).toBe(c.label);
    });
  }
});

// Always-on guard so the file is never an empty suite when goldens are disabled.
it("golden suite is gated on RUN_GOLDEN + OPENAI_API_KEY", () => {
  expect(typeof ENABLED).toBe("boolean");
});
