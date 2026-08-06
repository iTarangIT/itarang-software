/**
 * The pure half of the ElevenLabs read model: series shaping, labels, masking.
 *
 * Split out of elevenlabs.ts for the same reason scheduling.ts is split out of
 * runner.ts — @/lib/db throws at import time when DATABASE_URL is unset and
 * otherwise opens a connection pool, so anything importing it cannot be unit
 * tested. Everything here is a pure function over plain data and is covered by
 * __tests__/elevenlabsSeries.test.ts.
 */

export interface DailyUsage {
  /** YYYY-MM-DD in IST. */
  day: string;
  calls: number;
  cost_paise: number;
}

export interface MonthlyUsage {
  /** YYYY-MM in IST. */
  month: string;
  calls: number;
  cost_paise: number;
}

/** Calls with no dialer_campaign_leads row — dialled outside any campaign. */
export const OUTSIDE_CAMPAIGN = "Outside campaign";
/** In a campaign, but that campaign carries no category. */
export const UNCATEGORISED = "Uncategorised campaign";

/**
 * Sentinels the SQL emits instead of NULL, so the two "no category" cases stay
 * distinguishable through a GROUP BY. They are deliberately not user-facing
 * strings — a campaign genuinely named "Outside campaign" would otherwise merge
 * into the residual bucket.
 */
export const OUTSIDE_MARKER = "__outside__";
export const UNCATEGORISED_MARKER = "__uncategorised__";

/** YYYY-MM-DD in IST. Matches istDate() in daily.ts. */
export function istDay(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** YYYY-MM in IST. */
export function istMonth(date: Date = new Date()): string {
  return istDay(date).slice(0, 7);
}

/**
 * Show enough of a number to recognise a lead, not enough to dial it from a
 * screenshot. The ops role is not a sales role.
 */
export function maskPhone(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  return s.length <= 4 ? s : `••••${s.slice(-4)}`;
}

/**
 * Fill the gaps in a trend series.
 *
 * The SQL only returns days that had calls. A day with no calls is the single
 * most important reading on this page — "sales stopped using it" — and a chart
 * built from the raw rows would close the gap and draw a continuous line over a
 * week of silence.
 */
export function fillDays(
  found: Map<string, { calls: number; cost_paise: number }>,
  days: number,
  today: Date = new Date(),
): DailyUsage[] {
  const out: DailyUsage[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = istDay(new Date(today.getTime() - i * 86_400_000));
    const hit = found.get(day);
    out.push({
      day,
      calls: hit?.calls ?? 0,
      cost_paise: hit?.cost_paise ?? 0,
    });
  }
  return out;
}

/**
 * Month-over-month across the two most recent COMPLETE months.
 *
 * "Complete" is decided against the real current IST month, not by dropping
 * monthly[0]: a month with no calls produces no row at all, so on 4 August the
 * newest row can already be a finished month, and dropping it would compare
 * June against May while ignoring the most recent real data. Same rule, and the
 * same reasoning, as spend.ts.
 */
export function momDelta(
  monthly: MonthlyUsage[],
  currentMonth: string,
): number | null {
  const complete = monthly.filter((m) => m.month !== currentMonth);
  // A zero base makes the percentage meaningless (or infinite), and "+∞%" is
  // not a number anyone can act on.
  if (complete.length < 2 || complete[1]!.cost_paise <= 0) return null;
  return (
    ((complete[0]!.cost_paise - complete[1]!.cost_paise) /
      complete[1]!.cost_paise) *
    100
  );
}

/** Marker → the label the page renders, plus whether it is a real category. */
export function categoryLabel(raw: string): {
  category: string;
  is_campaign: boolean;
} {
  if (raw === OUTSIDE_MARKER) {
    return { category: OUTSIDE_CAMPAIGN, is_campaign: false };
  }
  if (raw === UNCATEGORISED_MARKER) {
    return { category: UNCATEGORISED, is_campaign: true };
  }
  return { category: raw, is_campaign: true };
}
