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
//       llm: float,
//       network: float,                   // → telephony
//       platform: float,                  // Bolna platform fee
//       synthesizer: float,               // → TTS
//       transcriber: float                // → STT
//     },
//     telephony_data: { duration, recording_url, ... }
//   }

const BOLNA_BASE_URL =
  process.env.BOLNA_BASE_URL || "https://api.bolna.ai";

export type NormalizedCallCost = {
  success: boolean;
  totalCents: number | null;
  llmCents: number | null;
  ttsCents: number | null;
  sttCents: number | null;
  telephonyCents: number | null;
  platformCents: number | null;
  currency: "USD";
  source: "provider_api";
  error?: string;
};

function toCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value);
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
    currency: "USD",
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
      cost_breakdown?: {
        llm?: number;
        synthesizer?: number;
        transcriber?: number;
        network?: number;
        platform?: number;
      };
    };
    const breakdown = data.cost_breakdown ?? {};

    return {
      success: true,
      totalCents: toCents(data.total_cost),
      llmCents: toCents(breakdown.llm),
      ttsCents: toCents(breakdown.synthesizer),
      sttCents: toCents(breakdown.transcriber),
      telephonyCents: toCents(breakdown.network),
      platformCents: toCents(breakdown.platform),
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
