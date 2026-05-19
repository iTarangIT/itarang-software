// USD → INR display helpers. Cost is stored as USD cents (matching what
// Bolna and ElevenLabs return). Display layer converts to INR using a
// configurable rate so the team can adjust without touching the DB.
//
// NEXT_PUBLIC_USD_TO_INR_RATE is read on each call so server-rendered and
// client-rendered values stay in sync. Default 83 reflects the May 2026
// rough average — surface the live rate in the UI footnote so reviewers
// know the basis.

const DEFAULT_RATE = 83;

export function getUsdToInrRate(): number {
  const raw = process.env.NEXT_PUBLIC_USD_TO_INR_RATE;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RATE;
}

// Convert integer USD cents to whole INR rupees.
export function usdCentsToInr(usdCents: number | null | undefined): number {
  if (usdCents == null || !Number.isFinite(usdCents)) return 0;
  return (usdCents / 100) * getUsdToInrRate();
}

// "₹1,234" — whole rupees, en-IN grouping.
export function formatINR(usdCents: number | null | undefined): string {
  const rupees = usdCentsToInr(usdCents);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(rupees);
}

// "₹1,234.56" — two-decimal precision for per-call breakdowns where
// rounding the paise would hide differences between calls.
export function formatINRDetailed(usdCents: number | null | undefined): string {
  const rupees = usdCentsToInr(usdCents);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rupees);
}

// Per-minute cost: USD cents / duration_secs * 60 → INR/min.
export function formatINRPerMinute(
  usdCents: number | null | undefined,
  durationSecs: number | null | undefined,
): string {
  if (
    usdCents == null ||
    durationSecs == null ||
    !Number.isFinite(durationSecs) ||
    durationSecs <= 0
  ) {
    return "—";
  }
  const cents = (usdCents / durationSecs) * 60;
  return formatINRDetailed(cents);
}
