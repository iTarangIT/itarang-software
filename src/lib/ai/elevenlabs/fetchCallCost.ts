// Fetches per-call cost from the ElevenLabs Conversational AI conversation
// endpoint after the call has finalized. Used by finalizeElevenLabsCall
// (best-effort post-persist) and /api/cron/backfill-call-costs (retry).
//
// API surface (verified May 2026 by curl against a live conversation):
//   GET https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}
//   Auth: header `xi-api-key: <ELEVENLABS_API_KEY>`
//
// Response excerpt with REAL units (this trapped us once — see below):
//   metadata.cost: integer       — ELEVENLABS CREDITS, not dollars/cents
//   metadata.charging.llm_charge: integer     — credits
//   metadata.charging.call_charge: integer    — credits
//   metadata.charging.llm_price: number       — USD (dollars)  ← anchor
//   metadata.charging.tier: string            — "creator", "free", ...
//
// Naming trap: ElevenLabs calls these "charge" / "cost", which sounds like
// money. They aren't. They're credit counts. The only dollar field is
// `llm_price`. We derive credits-to-USD from (llm_price / llm_charge) on
// the same call when possible — this is exact and tier-correct. If
// llm_charge is 0 we fall back to env-configurable ELEVENLABS_USD_PER_CREDIT
// (default 0.000179 ≈ Creator tier; ≈ $0.10/min agent voice).

import type { NormalizedCallCost } from "../bolna_ai/fetchCallCost";

const BASE_URL =
  process.env.ELEVENLABS_API_BASE_URL || "https://api.elevenlabs.io";

// Default rate matches Creator tier observed empirically:
//   298 credits = ~$0.053 for a 40s call at $0.08/min → $0.000178/credit
function defaultUsdPerCredit(): number {
  const raw = process.env.ELEVENLABS_USD_PER_CREDIT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.000179;
}

function creditsToCents(credits: unknown, usdPerCredit: number): number | null {
  if (typeof credits !== "number" || !Number.isFinite(credits)) return null;
  // credits → dollars → cents. Round to nearest cent — sub-cent
  // precision isn't meaningful at the dashboard level.
  return Math.round(credits * usdPerCredit * 100);
}

export async function fetchElevenLabsCallCost(
  conversationId: string,
): Promise<NormalizedCallCost> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const empty: NormalizedCallCost = {
    success: false,
    totalCents: null,
    llmCents: null,
    ttsCents: null,
    sttCents: null,
    telephonyCents: null,
    platformCents: null,
    currency: "USD",
    source: "provider_api",
  };

  if (!apiKey) {
    return { ...empty, error: "ELEVENLABS_API_KEY not set" };
  }
  if (!conversationId) {
    return { ...empty, error: "conversationId required" };
  }

  try {
    const res = await fetch(
      `${BASE_URL}/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
      {
        headers: { "xi-api-key": apiKey, accept: "application/json" },
      },
    );

    if (!res.ok) {
      return { ...empty, error: `ElevenLabs cost fetch ${res.status}` };
    }

    const data = (await res.json()) as {
      metadata?: {
        cost?: number;
        charging?: {
          llm_charge?: number;
          call_charge?: number;
          llm_price?: number;
        };
      };
    };
    const meta = data.metadata ?? {};
    const charging = meta.charging ?? {};

    // Derive USD-per-credit from this call's own data when possible. The
    // llm_price field is in dollars and llm_charge is in credits, so the
    // ratio is exact and tier-correct for the active account. Falls back
    // to env-configured default when the LLM portion was zero.
    let usdPerCredit = defaultUsdPerCredit();
    if (
      typeof charging.llm_price === "number" &&
      typeof charging.llm_charge === "number" &&
      charging.llm_charge > 0 &&
      Number.isFinite(charging.llm_price) &&
      charging.llm_price > 0
    ) {
      usdPerCredit = charging.llm_price / charging.llm_charge;
    }

    return {
      success: true,
      totalCents: creditsToCents(meta.cost, usdPerCredit),
      llmCents: creditsToCents(charging.llm_charge, usdPerCredit),
      // ElevenLabs bundles TTS+STT into the per-minute call charge, so we
      // can't break them out separately. Leave nullable so the dashboard
      // shows ₹0 with a footnote rather than fabricating data.
      ttsCents: null,
      sttCents: null,
      telephonyCents: creditsToCents(charging.call_charge, usdPerCredit),
      platformCents: null,
      currency: "USD",
      source: "provider_api",
    };
  } catch (err) {
    return {
      ...empty,
      error: err instanceof Error ? err.message : "fetch failed",
    };
  }
}
