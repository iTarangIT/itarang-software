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
  // The two rows must be ADJACENT calendar months. Callers that gap-fill hand
  // us a dense array and this always holds; a caller that does not (spend.ts's
  // burn query returns only months that HAVE invoices) would otherwise get
  // July-against-May computed and labelled "month over month". Refusing is the
  // honest answer — there is no month-over-month when a month is missing.
  if (addMonths(complete[0]!.month, -1) !== complete[1]!.month) return null;
  return (
    ((complete[0]!.cost_paise - complete[1]!.cost_paise) /
      complete[1]!.cost_paise) *
    100
  );
}

// ---------------------------------------------------------------- ranges --
//
// The date filter behind /operations/elevenlabs. Presets and the month selector
// resolve through the SAME function: a month is just a range whose bounds happen
// to be one calendar month, so there is no second code path for month filtering
// anywhere in the SQL, the view or the API route.
//
// All arithmetic below is pure string/UTC work over YYYY-MM-DD and YYYY-MM. It
// never constructs a local-time Date from those strings, because that is where
// the "February became January 31st" class of bug comes from.

/** A preset key, or a YYYY-MM month. */
export type ElevenLabsRangeKey = "mtd" | "3m" | "6m" | "all" | (string & {});

export const DEFAULT_RANGE: ElevenLabsRangeKey = "mtd";

/** The four presets, in the order the filter bar renders them. */
export const RANGE_PRESETS = [
  { key: "mtd", label: "Current month" },
  { key: "3m", label: "Last 3 months" },
  { key: "6m", label: "Last 6 months" },
  { key: "all", label: "All time" },
] as const;

/**
 * Beyond this many days a daily bar chart stops being readable and the SVG
 * stops being a sensible size, so the trend switches to calendar-month bars.
 * 92 keeps "last 3 months" daily (its longest possible span is 92 days).
 */
const DAY_BUCKET_MAX_SPAN = 92;

/** Hard ceilings on enumerated buckets, so a hand-edited URL cannot fan out. */
const MAX_FILL_DAYS = 400;
const MAX_FILL_MONTHS = 120;

/** How many months the selector offers. Three years is more than enough. */
const MONTH_OPTION_CAP = 36;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** A custom window: two IST days joined by "..", e.g. 2026-01-12..2026-04-27. */
const CUSTOM_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

export interface ElevenLabsFilters {
  /** The validated URL value. Echoed back into every link. */
  key: ElevenLabsRangeKey;
  /** YYYY-MM-DD in IST, inclusive. null = unbounded (all time). */
  from: string | null;
  /** YYYY-MM-DD in IST, inclusive. null = unbounded. */
  to: string | null;
  /** Full prose for captions: "February 2026", "Last 6 months". */
  label: string;
  /** Tight form for the badge that must stay on one line: "Feb 26", "6m". */
  short: string;
  /** Trend chart granularity. */
  bucket: "day" | "month";
}

/** "2026-02" → { y: 2026, m: 2 } (m is 1-based). */
function splitMonth(ym: string): { y: number; m: number } {
  return { y: Number(ym.slice(0, 4)), m: Number(ym.slice(5, 7)) };
}

/**
 * Is this a real calendar day, not merely a well-shaped string?
 *
 * DAY_RE accepts 2026-02-31 and 2025-02-29 — both match the pattern and neither
 * exists. Round-tripping through Date.UTC is what catches them: an overflowing
 * day rolls into the next month and stops matching itself.
 */
function isRealDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const [y, m, d] = day.split("-").map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d!));
  return at.toISOString().slice(0, 10) === day;
}

/** True for a custom `from..to` key, false for any preset or YYYY-MM. */
export function isCustomRange(key: ElevenLabsRangeKey): boolean {
  return CUSTOM_RE.test(key);
}

/** "2026-01-12" → "12 Jan 2026". */
export function formatDayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** "2026-01-12" → "12 Jan". Year dropped for the one-line badge. */
function formatDayShort(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** Shift a YYYY-MM by n months. Handles year rollover in both directions. */
export function addMonths(ym: string, n: number): string {
  const { y, m } = splitMonth(ym);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}

/** First day of a YYYY-MM. */
export function monthStart(ym: string): string {
  return `${ym}-01`;
}

/**
 * Last day of a YYYY-MM. Date.UTC(y, m, 0) is "day zero of the NEXT month",
 * i.e. the last day of this one — which is how February gets 29 in a leap year
 * without a leap-year branch of our own.
 */
export function monthEnd(ym: string): string {
  const { y, m } = splitMonth(ym);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, "0")}`;
}

/** "2026-01" → "January 2026". The format the requirement names literally. */
export function monthLabel(ym: string): string {
  const { y, m } = splitMonth(ym);
  // Mid-month, in UTC: no timezone can shift a 15th into an adjacent month.
  return new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, 15)));
}

/** "2026-01" → "Jan 26". For the one-line badge. */
export function monthShort(ym: string): string {
  const { y, m } = splitMonth(ym);
  const mon = new Intl.DateTimeFormat("en-IN", {
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, 15)));
  return `${mon} ${String(y).slice(2)}`;
}

/** Whole calendar months from one YYYY-MM to another. */
function monthsBetween(from: string, to: string): number {
  const a = splitMonth(from);
  const b = splitMonth(to);
  return b.y * 12 + (b.m - 1) - (a.y * 12 + (a.m - 1));
}

/**
 * A day bucket from SQL, as the `YYYY-MM-DD` key fillRange() builds.
 *
 * THIS EXISTS BECAUSE OF A SILENT, TOTAL FAILURE. The trend query selects
 * `...::date`, and postgres.js parses oid 1082 through `parse: x => new Date(x)`
 * — so the value arriving in JS is a `Date`, not a string. The old code did
 * `String(r.date).slice(0, 10)`, which on a Date yields "Mon Jun 22", while
 * fillRange() builds "2026-06-22". The two maps never intersected, so EVERY
 * day-bucketed chart on /operations/elevenlabs rendered as a flat row of zeros
 * — the default view (month to date), "Last 3 months", every specific month and
 * every custom window ≤ 92 days. Two different ranges produced two identical
 * empty charts, which is what "the values repeat" looked like from outside.
 * The month-bucketed views were fine because TO_CHAR returns a real string.
 *
 * Both shapes are accepted deliberately: a driver upgrade that started
 * returning strings must not silently reintroduce the bug in the other
 * direction. A `date` column carries no time and no zone, and postgres.js
 * builds it from the bare "YYYY-MM-DD" text, so the instant is UTC midnight and
 * toISOString() reads back the same calendar day it was selected as.
 */
export function toIsoDay(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    const trimmed = value.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
  }
  return null;
}

/** Inclusive whole-day span between two YYYY-MM-DD strings. */
function spanDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000) + 1;
}

/**
 * Validate a `range` URL value. SHAPE ONLY — mirrors parseFilters() in logs.ts.
 *
 * Deliberately does NOT clamp a month against first_call_at: that would need a
 * DB read inside a pure function, and a month with no data renders the normal
 * empty state rather than an error. A month in the FUTURE is rejected though —
 * it can only be a typo, and it would query a guaranteed-empty window.
 */
export function parseRange(
  params: Record<string, string | string[] | undefined>,
  now: Date = new Date(),
): ElevenLabsRangeKey {
  const one = (key: string): string | undefined => {
    const raw = params[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" ? value : undefined;
  };

  // A custom window arrives in two shapes and both mean the same thing:
  //
  //   ?from=2026-01-12&to=2026-04-27   what the date form submits, because a
  //                                    plain GET form cannot merge two inputs
  //                                    into one parameter without JavaScript,
  //                                    and this bar must work before JS loads.
  //   ?range=2026-01-12..2026-04-27    the canonical form every link we build
  //                                    uses, so the rest of the module still
  //                                    sees exactly one parameter.
  //
  // Checked FIRST so the pair wins outright when present. There is no
  // precedence puzzle in practice: submitting a GET form replaces the whole
  // query string, so a URL never carries a preset and a custom window at once
  // unless somebody hand-writes one.
  const custom = normaliseCustom(one("from"), one("to"), now);
  if (custom) return custom;

  const value = one("range");
  if (typeof value !== "string") return DEFAULT_RANGE;

  if (value === "mtd" || value === "3m" || value === "6m" || value === "all") {
    return value;
  }
  if (MONTH_RE.test(value) && value <= istMonth(now)) return value;

  const pair = CUSTOM_RE.exec(value);
  if (pair) {
    const fromPair = normaliseCustom(pair[1], pair[2], now);
    if (fromPair) return fromPair;
  }
  return DEFAULT_RANGE;
}

/**
 * Validate a custom window and return it as the canonical `from..to` key, or
 * null if it is not usable.
 *
 * Rejects rather than repairs, for the same reason the month check does: a
 * silently-corrected range would leave the URL describing a window that is not
 * on screen. The one exception is a `to` in the future, which is clamped to
 * today — future dates carry no data by definition, so trimming them changes
 * nothing about what is displayed while letting a date picker's default
 * end-of-month value through instead of throwing the whole range away.
 */
function normaliseCustom(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  now: Date,
): string | null {
  if (!fromRaw || !toRaw) return null;
  if (!isRealDay(fromRaw) || !isRealDay(toRaw)) return null;

  const today = istDay(now);
  const from = fromRaw;
  const to = toRaw > today ? today : toRaw;

  // An inverted range is a user error, not something to silently swap: swapping
  // would show a window nobody asked for.
  if (from > to) return null;
  // Entirely in the future — nothing to clamp to.
  if (from > today) return null;
  // The same ceiling fillRange() enforces, applied here so the URL is rejected
  // rather than quietly truncated at 400 bars.
  if (spanDays(from, to) > MAX_FILL_DAYS) return null;

  return `${from}..${to}`;
}

/**
 * Turn a validated key into concrete IST bounds.
 *
 * Preset spans are CALENDAR months, not trailing 90/180 days, for the reason
 * already written into the six-month query in elevenlabs.ts: a fragment bucket
 * at the far edge reads as a collapse in usage rather than as a partial month.
 */
export function resolveRange(
  key: ElevenLabsRangeKey = DEFAULT_RANGE,
  now: Date = new Date(),
): ElevenLabsFilters {
  const today = istDay(now);
  const thisMonth = istMonth(now);

  if (key === "all") {
    return {
      key,
      from: null,
      to: null,
      label: "All time",
      short: "All",
      bucket: "month",
    };
  }

  // A custom window. Bounds are already validated by parseRange, so this only
  // has to label and bucket them — the same DAY_BUCKET_MAX_SPAN rule the
  // presets use, so three days gets three bars and two years gets month bars.
  const custom = CUSTOM_RE.exec(key);
  if (custom) {
    const from = custom[1]!;
    const to = custom[2]!;
    const sameDay = from === to;
    return {
      key,
      from,
      to,
      label: sameDay
        ? formatDayLabel(from)
        : `${formatDayLabel(from)} – ${formatDayLabel(to)}`,
      // Year dropped from the start date when both fall in the same year, so
      // the badge stays on one line for the common case.
      short: sameDay
        ? formatDayShort(from)
        : `${formatDayShort(from)}–${
            from.slice(0, 4) === to.slice(0, 4)
              ? formatDayShort(to)
              : formatDayLabel(to)
          }`,
      bucket: spanDays(from, to) > DAY_BUCKET_MAX_SPAN ? "month" : "day",
    };
  }

  if (key === "3m" || key === "6m") {
    const back = key === "3m" ? 2 : 5;
    const from = monthStart(addMonths(thisMonth, -back));
    const bucket =
      spanDays(from, today) > DAY_BUCKET_MAX_SPAN ? "month" : "day";
    return {
      key,
      from,
      to: today,
      label: key === "3m" ? "Last 3 months" : "Last 6 months",
      short: key,
      bucket,
    };
  }

  // A specific month, or the current month (mtd). Both are one calendar month;
  // mtd is simply the current one, which is why they share this branch.
  const ym = key === "mtd" ? thisMonth : key;
  const isCurrent = ym === thisMonth;
  return {
    key,
    from: monthStart(ym),
    // The current month has not finished, so stop at today rather than at the
    // 31st — otherwise the chart draws a week of future zeros.
    to: isCurrent ? today : monthEnd(ym),
    label: isCurrent ? `${monthLabel(ym)} · month to date` : monthLabel(ym),
    short: isCurrent && key === "mtd" ? "MTD" : monthShort(ym),
    bucket: "day",
  };
}

/**
 * The immediately preceding window of equal length, for the "vs previous" hint.
 *
 * Month-shaped ranges step back a whole calendar month (February compares
 * against January, not against "the 28 days before February"). Day-shaped ones
 * step back their own span. All time has no predecessor.
 */
export function prevRange(
  filters: ElevenLabsFilters,
): { from: string; to: string } | null {
  if (!filters.from || !filters.to) return null;

  // Every range this module produces starts on a month boundary, so shift BOTH
  // ends back by however many calendar months the window spans. Shifting by one
  // month regardless would compare "last 3 months" against a single month.
  if (filters.from.endsWith("-01")) {
    const fromMonth = filters.from.slice(0, 7);
    const toMonth = filters.to.slice(0, 7);
    const spanned = monthsBetween(fromMonth, toMonth) + 1;
    const prevFromMonth = addMonths(fromMonth, -spanned);
    const prevToMonth = addMonths(toMonth, -spanned);

    // A window that ends ON a month boundary is a COMPLETE month (or run of
    // them), so its predecessor should be complete too: February compares
    // against the whole of January, not against January 1-28.
    //
    // A window that stops mid-month is month-to-date, and compares against the
    // SAME stretch of the earlier month — 1-7 August against 1-7 July. Anything
    // else would show a fake collapse every time the page was opened early in a
    // month. Clamped, because 30 March has no counterpart in February.
    const complete = filters.to === monthEnd(toMonth);
    const prevLast = Number(monthEnd(prevToMonth).slice(8));
    const day = complete
      ? prevLast
      : Math.min(Number(filters.to.slice(8)), prevLast);

    return {
      from: monthStart(prevFromMonth),
      to: `${prevToMonth}-${String(day).padStart(2, "0")}`,
    };
  }

  // Fallback for a non-month-aligned window: the equal-length stretch that ends
  // the day before this one starts. Nothing produces these today.
  const span = spanDays(filters.from, filters.to);
  const fromMs = Date.parse(`${filters.from}T00:00:00Z`);
  return {
    from: new Date(fromMs - span * 86_400_000).toISOString().slice(0, 10),
    to: new Date(fromMs - 86_400_000).toISOString().slice(0, 10),
  };
}

/**
 * Months to offer in the selector, newest first.
 *
 * Bounded by the first call ever so the list cannot offer a month that predates
 * the data. firstCallAt null (no ElevenLabs calls at all) yields exactly one
 * entry — the current month — rather than an empty or disabled control, which
 * would read as a broken page rather than an empty one. That fallback is also
 * what the error path renders, where no view is available at all.
 */
export function monthOptions(
  firstCallAt: Date | string | null,
  now: Date = new Date(),
  cap: number = MONTH_OPTION_CAP,
): { value: string; label: string }[] {
  const current = istMonth(now);
  let oldest = current;
  if (firstCallAt) {
    const d = firstCallAt instanceof Date ? firstCallAt : new Date(firstCallAt);
    if (!Number.isNaN(d.getTime())) {
      const m = istMonth(d);
      if (m < current) oldest = m;
    }
  }

  const out: { value: string; label: string }[] = [];
  let ym = current;
  while (ym >= oldest && out.length < cap) {
    out.push({ value: ym, label: monthLabel(ym) });
    ym = addMonths(ym, -1);
  }
  return out;
}

/**
 * Fill the gaps in a day-bucketed trend over an ARBITRARY window.
 *
 * Same contract as fillDays (a day with no calls must be an explicit zero, not
 * a closed gap), but bounded by real dates rather than by "the last N days" —
 * which is what fillDays structurally cannot express, and the reason this
 * exists. Crucially it stops at `to`, so a historical month does not run on
 * through today.
 */
export function fillRange(
  found: Map<string, { calls: number; cost_paise: number }>,
  from: string,
  to: string,
): DailyUsage[] {
  const out: DailyUsage[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  let cursor = Date.parse(`${from}T00:00:00Z`);
  if (!Number.isFinite(cursor) || !Number.isFinite(end)) return out;

  while (cursor <= end && out.length < MAX_FILL_DAYS) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    const hit = found.get(day);
    out.push({
      day,
      calls: hit?.calls ?? 0,
      cost_paise: hit?.cost_paise ?? 0,
    });
    cursor += 86_400_000;
  }
  return out;
}

/**
 * Month-bucketed equivalent of fillRange, for the wide windows (6m, all time)
 * where day bars would be an unreadable several-thousand-pixel SVG.
 *
 * Bounds are YYYY-MM-DD; only their month part is used.
 */
export function fillMonths(
  found: Map<string, { calls: number; cost_paise: number }>,
  from: string,
  to: string,
): MonthlyUsage[] {
  const out: MonthlyUsage[] = [];
  const last = to.slice(0, 7);
  let ym = from.slice(0, 7);
  if (!MONTH_RE.test(ym) || !MONTH_RE.test(last)) return out;

  // MAX_FILL_MONTHS mirrors MAX_FILL_DAYS: a hand-edited `from` cannot fan out.
  while (ym <= last && out.length < MAX_FILL_MONTHS) {
    const hit = found.get(ym);
    out.push({
      month: ym,
      calls: hit?.calls ?? 0,
      cost_paise: hit?.cost_paise ?? 0,
    });
    ym = addMonths(ym, 1);
  }
  return out;
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
