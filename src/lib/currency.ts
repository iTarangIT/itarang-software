// Cost display helpers. Cost is stored in `ai_call_logs.*_cost_cents` as
// INR minor units (paise) for every provider — the conversion to INR happens
// once, at fetch time, in `src/lib/ai/*/fetchCallCost.ts`:
//   - ElevenLabs bills this account in ₹, so credits → INR directly.
//   - Bolna bills in USD, so USD → INR is applied there (market rate).
// The display layer therefore applies NO currency conversion — it only
// formats. (This file used to multiply by a USD→INR rate; that step is gone
// because nothing reaches display in USD any more. Re-introducing an FX
// multiply here would double-count.)

// Convert integer INR paise (the stored `*_cost_cents` columns) to rupees.
export function costCentsToInr(cents: number | null | undefined): number {
  if (cents == null || !Number.isFinite(cents)) return 0;
  return cents / 100;
}

// "₹1,234" — whole rupees, en-IN grouping.
export function formatINR(cents: number | null | undefined): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(costCentsToInr(cents));
}

// "₹1,234.56" — two-decimal precision for per-call breakdowns where
// rounding the paise would hide differences between calls.
export function formatINRDetailed(cents: number | null | undefined): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(costCentsToInr(cents));
}

// Per-minute cost: INR paise / duration_secs * 60 → ₹/min.
export function formatINRPerMinute(
  cents: number | null | undefined,
  durationSecs: number | null | undefined,
): string {
  if (
    cents == null ||
    durationSecs == null ||
    !Number.isFinite(durationSecs) ||
    durationSecs <= 0
  ) {
    return "—";
  }
  return formatINRDetailed((cents / durationSecs) * 60);
}
