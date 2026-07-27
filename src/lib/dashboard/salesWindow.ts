import { and, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { expenseSubmissions } from "@/lib/db/schema";

// Shared [start, end) date-window resolver for CEO dashboard drill-downs.
//   ?month=YYYY-MM  → that calendar month
//   ?period=fy      → financial year to date (India FY starts 1 April), open-ended
//   default / mtd   → current calendar month
// Returns local date strings (YYYY-MM-DD); endStr is null for the open-ended FY.

export function resolveWindow(
    month: string | null,
    period: string | null,
): { startStr: string; endStr: string | null } {
    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const curYear = now.getFullYear();
    const curMonth = now.getMonth();

    const monthMatch = month?.match(/^(\d{4})-(\d{2})$/);
    if (monthMatch) {
        const y = Number(monthMatch[1]);
        const mo = Number(monthMatch[2]);
        const ey = mo === 12 ? y + 1 : y;
        const em = mo === 12 ? 1 : mo + 1;
        return { startStr: `${y}-${pad2(mo)}-01`, endStr: `${ey}-${pad2(em)}-01` };
    }
    if ((period || "mtd") === "fy") {
        const fyStartYear = curMonth >= 3 ? curYear : curYear - 1;
        return { startStr: `${fyStartYear}-04-01`, endStr: null };
    }
    const ey = curMonth === 11 ? curYear + 1 : curYear;
    const em = curMonth === 11 ? 1 : curMonth + 2;
    return {
        startStr: `${curYear}-${pad2(curMonth + 1)}-01`,
        endStr: `${ey}-${pad2(em)}-01`,
    };
}

/**
 * E-214 — the date an expense belongs to.
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
 *   ordinary b-tree: `expense_submissions_approved_expense_date_idx` (E-214)
 *   and `expense_submissions_approved_at_idx` (E-105).
 *
 * Callers must keep `status = 'approved'` — it is part of both partial indexes.
 */
export function approvedExpenseInWindow(startStr: string, endStr: string | null) {
    const byExpenseDate = [gte(expenseSubmissions.expense_date, startStr)];
    if (endStr) byExpenseDate.push(lt(expenseSubmissions.expense_date, endStr));

    // Date literal vs timestamptz resolves at the session timezone, exactly as
    // the pre-E-214 queries did — the fallback path's behaviour is unchanged.
    const byApprovedAt = [gte(expenseSubmissions.approved_at, sql`${startStr}::date`)];
    if (endStr) byApprovedAt.push(lt(expenseSubmissions.approved_at, sql`${endStr}::date`));

    return and(
        eq(expenseSubmissions.status, "approved"),
        or(
            and(isNotNull(expenseSubmissions.expense_date), ...byExpenseDate),
            and(isNull(expenseSubmissions.expense_date), ...byApprovedAt),
        ),
    );
}
