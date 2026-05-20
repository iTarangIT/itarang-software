// Fetches per-call cost from the ElevenLabs Conversational AI conversation
// endpoint after the call has finalized. Used by finalizeElevenLabsCall
// (best-effort post-persist), /api/cron/backfill-call-costs (retry), and the
// LIST-based sync that catches conversations never delivered via webhook.
//
// API surface (verified May 2026 by curl against live conversations):
//   GET https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}
//   Auth: header `xi-api-key: <ELEVENLABS_API_KEY>`
//
// Cost fields used:
//   metadata.cost                                — total ELEVENLABS CREDITS
//   metadata.call_duration_secs                  — talk seconds
//   metadata.charging.{llm_charge, call_charge}  — credit components
//
// **Credit-to-INR rate — flat 0.0159742 ₹/credit by default.**
// This ElevenLabs account is billed in INR (confirmed against ElevenLabs →
// Settings → Billing). The Usage panel shows 31,000 credits = ₹495.20 →
// ₹0.0159742 per credit. There is deliberately NO USD step: ElevenLabs
// invoices this account in rupees, so the market USD/INR rate is irrelevant
// to ElevenLabs cost. We convert credits → INR and store INR paise directly.
//
// Env-overridable via `ELEVENLABS_INR_PER_CREDIT` so a plan/tier change or a
// re-verified invoice can be applied without a code deploy.

import type { NormalizedCallCost } from "../bolna_ai/fetchCallCost";

const BASE_URL =
  process.env.ELEVENLABS_API_BASE_URL || "https://api.elevenlabs.io";

function inrPerCredit(): number {
  const raw = process.env.ELEVENLABS_INR_PER_CREDIT;
  const parsed = raw ? Number(raw) : NaN;
  // Default 0.0159742 — ElevenLabs Usage panel: 31,000 credits = ₹495.20.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.0159742;
}

// Credits → INR paise (the integer minor-unit stored in `*_cost_cents`).
function creditsToPaise(credits: unknown, rate: number): number | null {
  if (typeof credits !== "number" || !Number.isFinite(credits)) return null;
  return Math.round(credits * rate * 100);
}

type ElevenLabsConversationDetail = {
  metadata?: {
    cost?: number;
    call_duration_secs?: number;
    charging?: {
      llm_charge?: number;
      call_charge?: number;
    };
  };
};

// Used by the backfill cron and the LIST sync to combine fetch + parse into
// one call. Public so the sync script can pass an already-fetched detail
// payload and avoid re-fetching.
export function parseElevenLabsCallCost(
  data: ElevenLabsConversationDetail,
): Omit<NormalizedCallCost, "success" | "error"> & { success: true } {
  const meta = data.metadata ?? {};
  const charging = meta.charging ?? {};
  const rate = inrPerCredit();

  const durationCandidate = meta.call_duration_secs;
  const durationSecs =
    typeof durationCandidate === "number" && Number.isFinite(durationCandidate)
      ? Math.round(durationCandidate)
      : null;

  return {
    success: true,
    totalCents: creditsToPaise(meta.cost, rate),
    llmCents: creditsToPaise(charging.llm_charge, rate),
    // ElevenLabs bundles TTS+STT into the per-minute call charge, so we can't
    // attribute them separately; leave nullable so the dashboard footnote
    // can explain rather than fabricating data.
    ttsCents: null,
    sttCents: null,
    telephonyCents: creditsToPaise(charging.call_charge, rate),
    platformCents: null,
    durationSecs,
    currency: "INR",
    source: "provider_api",
  };
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
    durationSecs: null,
    currency: "INR",
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

    const data = (await res.json()) as ElevenLabsConversationDetail;
    return parseElevenLabsCallCost(data);
  } catch (err) {
    return {
      ...empty,
      error: err instanceof Error ? err.message : "fetch failed",
    };
  }
}
