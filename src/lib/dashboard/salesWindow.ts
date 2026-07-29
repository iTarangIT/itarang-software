import { and, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { expenseSubmissions } from "@/lib/db/schema";

// Shared [start, end) date-window resolver for CEO dashboard drill-downs.
//   ?month=YYYY-MM      → that calendar month
//   ?year=YYYY          → that whole calendar year (Jan–Dec)
//   ?from=&to=          → an explicit day range, `to` inclusive (E-219)
//   ?period=fy          → financial year to date (India FY starts 1 April)
//   ?period=ytd         → calendar year to date (E-219)
//   ?period=inception   → everything ever recorded, no lower bound (E-219)
//   default / mtd       → current calendar month
// Returns local date strings (YYYY-MM-DD). `endStr` is null for the open-ended
// periods; `startStr` is null only for `inception`.

const pad2 = (n: number) => String(n).padStart(2, "0");

const MONTH_ABBR = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const monthLabel = (startStr: string) =>
    new Date(`${startStr}T00:00:00`).toLocaleDateString("en-IN", {
        month: "short",
        year: "numeric",
    });

/**
 * "2026-04-01" → "1 Apr 2026". Built from a static table rather than
 * `toLocaleDateString`, because a range label is the only on-screen proof of
 * which days a figure covers — the server's timezone must not be able to shift
 * it by a day.
 */
const dayLabel = (s: string) =>
    `${Number(s.slice(8, 10))} ${MONTH_ABBR[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True only for a real calendar day. The round-trip through Date catches the
 * dates that match the shape but do not exist — "2026-02-30" parses happily and
 * silently becomes 2 March, which would widen a window past what was asked for.
 */
export function isValidDayString(value: string): boolean {
    if (!DATE_RE.test(value)) return false;
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The day after `dateStr`, so a user-inclusive `to` becomes a half-open end. */
function nextDay(dateStr: string): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

export interface DayRange {
    from?: string | null;
    /** Inclusive — the resolver rolls it forward to build a half-open window. */
    to?: string | null;
}

export interface ResolvedWindow {
    /** Null means no lower bound at all (period=inception). */
    startStr: string | null;
    endStr: string | null;
    /**
     * Canonical echo of what was resolved: "mtd" | "ytd" | "fy" | "inception" |
     * "range" | "YYYY-MM" | "year-YYYY".
     */
    period: string;
    /** Human label for a card subtitle, e.g. "Jun 2026" or "Year 2026". */
    label: string;
}

export function resolveWindow(
    month: string | null,
    period: string | null,
    year?: string | null,
    range?: DayRange | null,
): ResolvedWindow {
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth();

    const monthMatch = month?.match(/^(\d{4})-(\d{2})$/);
    if (monthMatch) {
        const y = Number(monthMatch[1]);
        const mo = Number(monthMatch[2]);
        const ey = mo === 12 ? y + 1 : y;
        const em = mo === 12 ? 1 : mo + 1;
        const startStr = `${y}-${pad2(mo)}-01`;
        return {
            startStr,
            endStr: `${ey}-${pad2(em)}-01`,
            period: month!,
            label: monthLabel(startStr),
        };
    }
    // Guarded so a malformed ?year= falls through to the default window rather
    // than producing "NaN-01-01" and a query that matches nothing. Callers that
    // owe the user a 400 instead should go through resolveWindowParams.
    if (year && /^\d{4}$/.test(year)) {
        const y = Number(year);
        return {
            startStr: `${y}-01-01`,
            endStr: `${y + 1}-01-01`,
            period: `year-${y}`,
            label: `Year ${y}`,
        };
    }
    // An explicit range beats the period keyword: the filter bar sends
    // `period=range` alongside the dates, and picking dates must never resolve
    // to the period button that was highlighted a moment earlier.
    let rawFrom = range?.from && isValidDayString(range.from) ? range.from : null;
    let rawTo = range?.to && isValidDayString(range.to) ? range.to : null;
    if (rawFrom && rawTo && rawFrom > rawTo) [rawFrom, rawTo] = [rawTo, rawFrom];
    if (rawFrom || rawTo) {
        const label = rawFrom && rawTo
            ? `${dayLabel(rawFrom)} – ${dayLabel(rawTo)}`
            : rawFrom
                ? `${dayLabel(rawFrom)} onwards`
                : `up to ${dayLabel(rawTo!)}`;
        return {
            startStr: rawFrom,
            // `to` is what the user picked, so it has to be inside the window.
            endStr: rawTo ? nextDay(rawTo) : null,
            period: "range",
            label,
        };
    }

    if (period === "inception") {
        return {
            startStr: null,
            endStr: null,
            period: "inception",
            label: "Since inception",
        };
    }

    if (period === "ytd") {
        return {
            startStr: `${curYear}-01-01`,
            endStr: null,
            period: "ytd",
            label: `YTD since 1 Jan ${curYear}`,
        };
    }

    if ((period || "mtd") === "fy") {
        const fyStartYear = curMonth >= 3 ? curYear : curYear - 1;
        return {
            startStr: `${fyStartYear}-04-01`,
            endStr: null,
            period: "fy",
            label: `FY since 1 Apr ${fyStartYear}`,
        };
    }
    const ey = curMonth === 11 ? curYear + 1 : curYear;
    const em = curMonth === 11 ? 1 : curMonth + 2;
    const startStr = `${curYear}-${pad2(curMonth + 1)}-01`;
    return {
        startStr,
        endStr: `${ey}-${pad2(em)}-01`,
        period: "mtd",
        label: monthLabel(startStr),
    };
}

export type TrendGranularity = "day" | "week" | "month";

/**
 * The bucket size a window should be charted at, when the viewer has not picked
 * one. Drawing a financial year as daily bars gives ~365 slivers nobody can
 * read; drawing a single month as monthly bars gives exactly one. So the
 * default follows the span, and the chart's own Daily/Weekly/Monthly toggle
 * stays available on top of it.
 */
export function defaultGranularity(w: ResolvedWindow): TrendGranularity {
    if (w.period === "mtd" || /^\d{4}-\d{2}$/.test(w.period)) return "day";
    if (w.period === "range") {
        // An open-ended range could span years — months is the safe default.
        if (!w.startStr || !w.endStr) return "month";
        const days =
            (Date.parse(`${w.endStr}T00:00:00Z`) - Date.parse(`${w.startStr}T00:00:00Z`)) /
            86_400_000;
        return days < 62 ? "day" : "month";
    }
    return "month";
}

/**
 * `resolveWindow` with the input validation the CEO expense routes owe their
 * callers. It exists because those routes answer a malformed `?month=2026-13`
 * or `?year=abcd` with a 400 rather than quietly showing the current month —
 * a silently wrong number on a finance dashboard is worse than an error.
 *
 * Returns a discriminated result instead of throwing so the route can map the
 * failure to a 400; its outer catch is for genuine 500s.
 */
export function resolveWindowParams(
    sp: URLSearchParams,
):
    | { ok: true; window: ResolvedWindow }
    | { ok: false; error: string } {
    const month = sp.get("month");
    const year = sp.get("year");
    const from = sp.get("from");
    const to = sp.get("to");

    if (month) {
        const m = month.match(/^(\d{4})-(\d{2})$/);
        const mo = m ? Number(m[2]) : NaN;
        if (!m || mo < 1 || mo > 12) return { ok: false, error: "invalid month" };
    }
    // Only checked when `month` did not already win — matching the precedence
    // in resolveWindow, so a request carrying both is not rejected for a stale
    // year it will never use.
    if (!month && year) {
        const y = Number(year);
        if (!/^\d{4}$/.test(year) || y < 2000 || y > 2100) {
            return { ok: false, error: "invalid year" };
        }
    }
    // Rejected rather than dropped. A dropped end would fall back to the
    // current month while the picker still shows the dates the CEO chose —
    // a number captioned with a range it does not actually cover.
    if ((from && !isValidDayString(from)) || (to && !isValidDayString(to))) {
        return { ok: false, error: "invalid date range" };
    }

    return {
        ok: true,
        window: resolveWindow(month, sp.get("period"), month ? null : year, { from, to }),
    };
}

/**
 * E-216 — the date an expense belongs to.
 *
 * Every CEO expense figure used to window on `approved_at`, which for an
 * AI-extracted row is the moment somebody imported it, not the date on the
 * bill. That was survivable while invoices were dragged in one at a time
 * shortly after they arrived. It stops being survivable the moment a Drive
 * folder of historic invoices is scanned: a year of spend would land in
 * whichever month the scan happened to run.
 *
 * So the window is the invoice's own date, falling back to `approved_at` for
 * older rows that never captured one. This also brings the dashboard into
 * line with the XLSX export, which already used COALESCE(expense_date, …).
 *
 * Import these helpers rather than hand-copying the logic — four routes share
 * it, and a copied SQL fragment is how they would drift apart.
 */

/**
 * The effective date as a single expression. Safe for ORDER BY and SELECT, but
 * deliberately NOT used in the WHERE clause — see `approvedExpenseInWindow`.
 */
export const expenseEffectiveDate = () =>
    sql`COALESCE(${expenseSubmissions.expense_date}, ${expenseSubmissions.approved_at}::date)`;

/**
 * The approved-expense predicate for a [start, end) window. `endStr` null
 * means open-ended (financial year to date).
 *
 * WHY THIS IS AN `OR` AND NOT THE COALESCE ABOVE:
 *   `timestamptz::date` is STABLE, not IMMUTABLE — its result depends on the
 *   session TimeZone — so Postgres will not build an index on
 *   COALESCE(expense_date, approved_at::date). Attempting it fails with
 *   "functions in index expression must be marked IMMUTABLE" (42P17).
 *
 *   Pinning the zone would make it indexable but would quietly re-bucket rows
 *   across month boundaries (01:00 IST on the 1st is still last month in UTC),
 *   which is too high a price for an index.
 *
 *   Splitting it into two branches keeps the exact same semantics while
 *   comparing plain columns against constants, so each branch is served by an
 *   ordinary b-tree: `expense_submissions_approved_expense_date_idx` (E-216)
 *   and `expense_submissions_approved_at_idx` (E-105).
 *
 * Callers must keep `status = 'approved'` — it is part of both partial indexes.
 *
 * A null `startStr` means no lower bound (period=inception). With no bound at
 * either end there is nothing left to date-filter on, so the predicate reduces
 * to the status check — returning early rather than emitting an OR of two empty
 * branches, which Drizzle would render as `AND ()`.
 */
export function approvedExpenseInWindow(startStr: string | null, endStr: string | null) {
    if (!startStr && !endStr) return eq(expenseSubmissions.status, "approved");

    const byExpenseDate = [];
    if (startStr) byExpenseDate.push(gte(expenseSubmissions.expense_date, startStr));
    if (endStr) byExpenseDate.push(lt(expenseSubmissions.expense_date, endStr));

    // Date literal vs timestamptz resolves at the session timezone, exactly as
    // the pre-E-216 queries did — the fallback path's behaviour is unchanged.
    const byApprovedAt = [];
    if (startStr) byApprovedAt.push(gte(expenseSubmissions.approved_at, sql`${startStr}::date`));
    if (endStr) byApprovedAt.push(lt(expenseSubmissions.approved_at, sql`${endStr}::date`));

    return and(
        eq(expenseSubmissions.status, "approved"),
        or(
            and(isNotNull(expenseSubmissions.expense_date), ...byExpenseDate),
            and(isNull(expenseSubmissions.expense_date), ...byApprovedAt),
        ),
    );
}
