// Fetches per-call cost from the Bolna /executions/{id} endpoint after the
// call has finalized. Used by finalizeBolnaCall (best-effort post-persist)
// and by /api/cron/backfill-call-costs (retry sweep). Failure is logged but
// must not block the existing post-call pipeline — analysis, scoring, and
// campaign advance need to run regardless.
//
// Bolna API surface (verified May 2026 against docs):
//   GET https://api.bolna.ai/executions/{execution_id}
//   Auth: `Authorization: Bearer <BOLNA_API_KEY>`
// Response (relevant fields):
//   {
//     total_cost: float,                  // USD cents
//     conversation_duration: float,
//     status: string,
//     cost_breakdown: {
//       llm: float,                       // USD cents
//       network: float,                   // → telephony
//       platform: float,                  // Bolna platform fee
//       synthesizer: float,               // → TTS
//       transcriber: float                // → STT
//     },
//     telephony_data: { duration, recording_url, ... }
//   }
//
// **Currency:** Bolna invoices this account in USD, so every figure above is
// in USD cents. We convert USD → INR once, here at fetch time, and the rest
// of the pipeline + the dashboard work purely in INR paise. The USD/INR rate
// is env-overridable (`USD_TO_INR_RATE`); it drifts with the market, so
// refresh it from a recent invoice periodically. (ElevenLabs, by contrast,
// bills in ₹ — see elevenlabs/fetchCallCost.ts — and needs no FX step.)

const BOLNA_BASE_URL =
  process.env.BOLNA_BASE_URL || "https://api.bolna.ai";

export type NormalizedCallCost = {
  success: boolean;
  // All `*Cents` fields are INR paise — the unit stored in ai_call_logs.
  totalCents: number | null;
  llmCents: number | null;
  ttsCents: number | null;
  sttCents: number | null;
  telephonyCents: number | null;
  platformCents: number | null;
  // Talk duration in whole seconds. Persisted to ai_call_logs.call_duration so
  // the cost-analytics dashboard's "avg cost / minute" denominator is correct
  // even when the original webhook never delivered duration.
  durationSecs: number | null;
  currency: "INR";
  source: "provider_api";
  error?: string;
};

function usdToInrRate(): number {
  const raw = process.env.USD_TO_INR_RATE;
  const parsed = raw ? Number(raw) : NaN;
  // Default 96.86 — May 2026 market rate. Override via env from an invoice.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 96.86;
}

// Bolna returns each cost figure in USD cents; convert to INR paise.
// USD cents × (₹/$) = INR paise (the /100 and ×100 cancel).
function toInrPaise(usdCents: unknown, rate: number): number | null {
  if (typeof usdCents !== "number" || !Number.isFinite(usdCents)) return null;
  return Math.round(usdCents * rate);
}

export async function fetchBolnaCallCost(
  executionId: string,
): Promise<NormalizedCallCost> {
  const apiKey = process.env.BOLNA_API_KEY;
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
    return { ...empty, error: "BOLNA_API_KEY not set" };
  }
  if (!executionId) {
    return { ...empty, error: "executionId required" };
  }

  try {
    const res = await fetch(
      `${BOLNA_BASE_URL}/executions/${encodeURIComponent(executionId)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
      },
    );

    if (!res.ok) {
      return { ...empty, error: `Bolna cost fetch ${res.status}` };
    }

    const data = (await res.json()) as {
      total_cost?: number;
      conversation_duration?: number;
      telephony_data?: { duration?: number };
      cost_breakdown?: {
        llm?: number;
        synthesizer?: number;
        transcriber?: number;
        network?: number;
        platform?: number;
      };
    };
    const breakdown = data.cost_breakdown ?? {};
    const rate = usdToInrRate();
    const durationCandidate =
      typeof data.conversation_duration === "number"
        ? data.conversation_duration
        : typeof data.telephony_data?.duration === "number"
          ? data.telephony_data.duration
          : null;
    const durationSecs =
      durationCandidate != null && Number.isFinite(durationCandidate)
        ? Math.round(durationCandidate)
        : null;

    return {
      success: true,
      totalCents: toInrPaise(data.total_cost, rate),
      llmCents: toInrPaise(breakdown.llm, rate),
      ttsCents: toInrPaise(breakdown.synthesizer, rate),
      sttCents: toInrPaise(breakdown.transcriber, rate),
      telephonyCents: toInrPaise(breakdown.network, rate),
      platformCents: toInrPaise(breakdown.platform, rate),
      durationSecs,
      currency: "INR",
      source: "provider_api",
    };
  } catch (err) {
    return {
      ...empty,
      error: err instanceof Error ? err.message : "fetch failed",
    };
  }
}
