/**
 * The window /operations/spend reconciles over.
 *
 * WHY THIS EXISTS. The Spend page used to render two windows side by side with
 * nothing naming either. The burn card showed month-to-date (August: ₹43,818.44)
 * and, directly below it, "Metered vs billed (30 days)" showed Hostinger at
 * ₹28,387.88 — a figure that includes two July invoices and excludes nothing,
 * and is therefore correct, and is also impossible to reconcile against the
 * number six inches above it. Both were right; the page was not. Reported as
 * "the Hostinger billed amount is wrong".
 *
 * So the window becomes explicit and selectable, and BOTH halves of the
 * reconciliation move together. A month is the default because that is the unit
 * an invoice arrives in and the unit the burn chart is drawn in, so the two
 * cards now agree by construction. Trailing 30 days stays available, because
 * matched-length windows are what make the metered-vs-billed GAP meaningful
 * (the original design note, which was right about the comparison and wrong
 * about leaving it unlabelled).
 *
 * Pure — no database import — so it can be unit tested. Same split as
 * elevenlabsSeries.ts, and the calendar helpers are imported from there rather
 * than re-derived: two copies of "what is the first day of this month in IST"
 * would eventually disagree.
 */

import {
  addMonths,
  istDay,
  istMonth,
  monthEnd,
  monthLabel,
  monthShort,
  monthStart,
} from "./elevenlabsSeries";

/** `30d`, or a `YYYY-MM` month. */
export type SpendWindowKey = string;

export const TRAILING_30 = "30d" as const;

/** Trailing window length, in days, INCLUSIVE of today. */
const TRAILING_DAYS = 30;

/** How many months back the selector offers. */
const MONTH_OPTIONS = 12;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface SpendWindow {
  key: SpendWindowKey;
  kind: "trailing" | "month";
  /** Inclusive IST day bounds, YYYY-MM-DD. Both halves use exactly these. */
  from: string;
  to: string;
  /** Prose for captions and column headers. */
  label: string;
  short: string;
  /** True when `to` is today because the period has not finished. */
  partial: boolean;
}

/** The default window: the current month, so the page agrees with its own chart. */
export function defaultSpendWindow(now: Date = new Date()): SpendWindowKey {
  return istMonth(now);
}

/**
 * Validate a `window` URL value. SHAPE ONLY — mirrors parseRange() in
 * elevenlabsSeries.ts, deliberately.
 *
 * A month in the future is rejected rather than clamped: it can only be a typo,
 * and it would query a guaranteed-empty window that renders as "no spend" —
 * indistinguishable from a real answer.
 */
export function parseSpendWindow(
  params: Record<string, string | string[] | undefined>,
  now: Date = new Date(),
): SpendWindowKey {
  const raw = params.window;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return defaultSpendWindow(now);
  if (value === TRAILING_30) return TRAILING_30;
  if (MONTH_RE.test(value) && value <= istMonth(now)) return value;
  return defaultSpendWindow(now);
}

/** Turn a validated key into concrete inclusive IST day bounds. */
export function resolveSpendWindow(
  key: SpendWindowKey = TRAILING_30,
  now: Date = new Date(),
): SpendWindow {
  const today = istDay(now);

  if (key === TRAILING_30) {
    // INCLUSIVE of today, so the span is genuinely 30 days. The previous
    // implementation used `> today - 30`, a strict comparison that produced a
    // 29-day billed window against a 30-day metered one — quietly breaking the
    // card's own "the same trailing 30 days" premise.
    const from = new Date(Date.parse(`${today}T00:00:00Z`));
    from.setUTCDate(from.getUTCDate() - (TRAILING_DAYS - 1));
    return {
      key,
      kind: "trailing",
      from: from.toISOString().slice(0, 10),
      to: today,
      label: `Last ${TRAILING_DAYS} days`,
      short: `${TRAILING_DAYS}d`,
      partial: true,
    };
  }

  const ym = MONTH_RE.test(key) ? key : istMonth(now);
  const isCurrent = ym === istMonth(now);
  return {
    key: ym,
    kind: "month",
    from: monthStart(ym),
    // A finished month ends on its last day; the current one ends today, so a
    // part-month is never compared against a whole one by accident.
    to: isCurrent ? today : monthEnd(ym),
    label: isCurrent ? `${monthLabel(ym)} · month to date` : monthLabel(ym),
    short: isCurrent ? "MTD" : monthShort(ym),
    partial: isCurrent,
  };
}

export interface SpendWindowOption {
  key: SpendWindowKey;
  label: string;
}

/**
 * The selector's options: trailing 30 days, then the last 12 months newest
 * first. Not clamped against the first invoice — a month with no spend renders
 * the normal empty state, and clamping would need a database read inside a
 * pure function.
 */
export function spendWindowOptions(now: Date = new Date()): SpendWindowOption[] {
  const current = istMonth(now);
  const months: SpendWindowOption[] = [];
  for (let i = 0; i < MONTH_OPTIONS; i++) {
    const ym = addMonths(current, -i);
    months.push({
      key: ym,
      label: i === 0 ? `${monthLabel(ym)} (this month)` : monthLabel(ym),
    });
  }
  return [{ key: TRAILING_30, label: `Last ${TRAILING_DAYS} days` }, ...months];
}
