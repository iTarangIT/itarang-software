/**
 * The month range behind the AI expense tracker's filter.
 *
 * Two callers resolve the same range: the list route that fills the table, and
 * the ZIP export behind the Download button sitting next to it. If those two
 * disagreed by even a day, Download would hand back a different set of rows
 * than the one on screen — so the arithmetic lives here once, and both import
 * it. The tracker UI imports `monthLabel` from here too, for the same reason:
 * the empty-state prose and the ZIP's README should name a range identically.
 *
 * Windows are half-open `[startStr, endStr)` day strings, like every other
 * expense window in the codebase. `endStr` is the first day of the month AFTER
 * `to`, so a range never has to care how long its last month is.
 *
 * Either end may be omitted — `from` alone means "onwards", `to` alone means
 * "up to", neither means all time.
 */

const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export interface MonthRange {
  /** First day of `from`, inclusive. Null when there is no lower bound. */
  startStr: string | null;
  /** First day of the month after `to`, exclusive. Null when unbounded above. */
  endStr: string | null;
  /** Safe for filenames and Excel sheet names: "2026-07", "2026-04_2026-07". */
  slug: string;
  /** For prose: "Jul 2026", "Apr 2026 – Jul 2026", "Apr 2026 onwards". */
  label: string;
  /** False only when neither end was given, i.e. the range is all of time. */
  bounded: boolean;
}

export type MonthRangeResult =
  | { ok: true; range: MonthRange }
  | { ok: false; error: string };

export function isMonthKey(value: string): boolean {
  return MONTH_RE.test(value);
}

/**
 * "2026-07" → "Jul 2026". A static table rather than `toLocaleDateString`, so
 * the server's locale and timezone cannot change what a filename or a README
 * says — this string ends up inside downloaded artifacts.
 */
export function monthLabel(month: string): string {
  if (!MONTH_RE.test(month)) return month;
  return `${MONTH_ABBR[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** "2026-07" → "2026-07-01", the inclusive first day. */
export function monthStart(month: string): string {
  return `${month}-01`;
}

/** "2026-12" → "2027-01-01", the exclusive end of a `[start, end)` window. */
export function monthAfter(month: string): string {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const rolls = mon === 12;
  const nextYear = rolls ? year + 1 : year;
  const nextMon = rolls ? 1 : mon + 1;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMon).padStart(2, "0")}-01`;
}

/**
 * Reads `from` / `to` (both YYYY-MM, both optional) off a query string.
 *
 * `month=YYYY-MM` is still accepted as a shorthand for `from=to=month` — that
 * is the parameter the export shipped with, so old links keep working.
 */
export function resolveMonthRange(sp: URLSearchParams): MonthRangeResult {
  const raw = (key: string) => sp.get(key)?.trim() ?? "";

  const single = raw("month");
  if (single && !MONTH_RE.test(single)) {
    return { ok: false, error: "month must be YYYY-MM" };
  }

  let from = single || raw("from");
  let to = single || raw("to");

  if (!single) {
    if (from && !MONTH_RE.test(from)) {
      return { ok: false, error: "from must be YYYY-MM" };
    }
    if (to && !MONTH_RE.test(to)) {
      return { ok: false, error: "to must be YYYY-MM" };
    }
    // Ends picked in the wrong order still say plainly what was meant. Reading
    // a backwards range as empty would just look like the filter is broken.
    if (from && to && from > to) [from, to] = [to, from];
  }

  let slug: string;
  let label: string;
  if (from && to) {
    slug = from === to ? from : `${from}_${to}`;
    label = from === to ? monthLabel(from) : `${monthLabel(from)} – ${monthLabel(to)}`;
  } else if (from) {
    slug = `from-${from}`;
    label = `${monthLabel(from)} onwards`;
  } else if (to) {
    slug = `upto-${to}`;
    label = `up to ${monthLabel(to)}`;
  } else {
    slug = "all";
    label = "all time";
  }

  return {
    ok: true,
    range: {
      startStr: from ? monthStart(from) : null,
      endStr: to ? monthAfter(to) : null,
      slug,
      label,
      bounded: Boolean(from || to),
    },
  };
}
