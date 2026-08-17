/**
 * GET /api/dashboard/ceo/expense-ledger
 *
 * Backs the CEO dashboard's Expense Ledger card, in both of its views: the
 * department summary it opens on, and the flat invoice list behind the toggle.
 *
 * It replaces a client-side arrangement that could not tell the truth. The
 * ledger used to render `m.ai_expenses` from /api/dashboard/ceo — a query with
 * no window and a hard `.limit(200)` — and then filter and total that array in
 * the browser. Two consequences: the card ignored the MTD/YTD/FY/range bar
 * sitting directly above it, and every figure it showed was capped at the most
 * recent 200 invoices ever recorded. A list of rows can survive being partial.
 * A total cannot: it invites a trust that a row list never asks for.
 *
 * So the window and every filter are applied here, and the summary is a real
 * GROUP BY rather than a reduce over whatever survived a cap.
 *
 * Three queries, one WHERE clause. The summary, the rows and the vendor options
 * are derived from the same predicate so they cannot describe different filters
 * — the failure mode of splitting this across endpoints is a summary that says
 * 42 invoices above a list that shows 11, with nothing on screen admitting why.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions, users } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import { resolveWindowParams } from "@/lib/dashboard/salesWindow";
import {
  EXPENSE_DEPARTMENT_VALUES,
  UNASSIGNED_DEPARTMENT_KEY,
  UNCLASSIFIED_BUCKET_KEY,
  expenseDepartmentLabel,
  isExpenseBucket,
} from "@/lib/expenses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Not `requireApiAdmin`. That helper's EXPENSE_ADMIN_ROLES is {admin,
 * sales_head} and excludes `ceo` — gating this route with it would 403 the one
 * person the page is built for. This is the same set the sibling CEO expense
 * routes use.
 */
const ALLOWED_ROLES = new Set(["ceo", "admin", "sales_head"]);

/**
 * The row cap, raised from the old 200.
 *
 * Kept rather than replaced with LIMIT/OFFSET paging because the shared
 * Pagination helper pages on the client over rows already in hand, and its
 * header comment names the cap as the thing to raise when a list outgrows it.
 * The summary below is NOT capped, so the headline numbers stay correct even
 * when the row list is truncated; `capped` is what lets the UI say so.
 */
const ROW_CAP = 1000;

/**
 * A user's search text as a safe ILIKE pattern.
 *
 * The escape has to happen before the wildcards are added, and the backslash
 * has to be escaped before `%` and `_`, or the escape character introduced by
 * the first replacement would itself be escaped by the later ones.
 */
const likePattern = (q: string) =>
  `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function GET(req: NextRequest) {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
      );
    }

    const sp = req.nextUrl.searchParams;

    const resolved = resolveWindowParams(sp);
    if (!resolved.ok) {
      return NextResponse.json(
        { success: false, error: { message: resolved.error } },
        { status: 400 },
      );
    }
    const { startStr, endStr, period, label } = resolved.window;

    /**
     * The effective expense day: the date on the bill, falling back to the day
     * the row was created for invoices that never captured one.
     *
     * This is deliberately NOT `approvedExpenseInWindow()`, which the other CEO
     * expense figures use. That helper forces status='approved' and falls back
     * to `approved_at` — a different population on a different date. This
     * ledger's population is `source='ai'` and the date it shows, sorts by and
     * groups by has to be the date it filters on, or the Date column and the
     * window disagree about which month a row is in.
     *
     * `timestamptz::date` is STABLE, so Postgres will not use an index for this
     * COALESCE (the trap documented in salesWindow.ts). At this table's size a
     * scan is cheap; revisit only if it measurably hurts.
     */
    const effectiveDate = sql`COALESCE(${expenseSubmissions.expense_date}, ${expenseSubmissions.created_at}::date)`;

    // Population + window. Every query below starts from these.
    const baseConds = [eq(expenseSubmissions.source, "ai")];
    if (startStr) baseConds.push(gte(effectiveDate, startStr));
    if (endStr) baseConds.push(lt(effectiveDate, endStr));

    /**
     * Unrecognised filter values are ignored rather than rejected, matching the
     * expenses drill-down. A stale bookmark carrying a department that has since
     * been renamed should show the unfiltered ledger, not a 400.
     */
    const deptParam = sp.get("department");
    const deptFilter =
      deptParam === UNASSIGNED_DEPARTMENT_KEY
        ? isNull(expenseSubmissions.department)
        : deptParam && EXPENSE_DEPARTMENT_VALUES.includes(deptParam as never)
          ? eq(expenseSubmissions.department, deptParam)
          : undefined;

    const bucketParam = sp.get("bucket");
    const bucketFilter =
      bucketParam === UNCLASSIFIED_BUCKET_KEY
        ? isNull(expenseSubmissions.bucket)
        : isExpenseBucket(bucketParam)
          ? eq(expenseSubmissions.bucket, bucketParam)
          : undefined;

    // Project and vendor are free text on the row, so there is no vocabulary to
    // validate against — an unknown value simply matches nothing, which is the
    // honest answer to "show me invoices from a vendor with no invoices".
    const projectParam = sp.get("project")?.trim() || null;
    const projectFilter = projectParam
      ? eq(expenseSubmissions.project_tag, projectParam)
      : undefined;

    const vendorParam = sp.get("vendor")?.trim() || null;
    const vendorFilter = vendorParam
      ? eq(expenseSubmissions.vendor, vendorParam)
      : undefined;

    /**
     * ?q= — free text across every field the ledger puts on screen.
     *
     * `%` and `_` are escaped before the wildcards go on, so a search for "50%"
     * looks for the literal string rather than matching every row in the table.
     * Backslash is Postgres's default LIKE escape character, hence escaping it
     * first.
     *
     * `amount` is cast to text so a search for "12000" finds the invoice; the
     * enum columns are matched raw so typing "ops" or "tech" works even though
     * the table renders their labels. ILIKE on a NULL column yields NULL, which
     * `or` treats as no match — the behaviour we want for empty fields.
     *
     * No index serves this and none can: it is a contains-match over seven
     * columns. It runs inside the window predicate, which has already narrowed
     * the set, and the whole table is in the low hundreds of rows.
     */
    const qParam = sp.get("q")?.trim() || null;
    const searchFilter = qParam
      ? or(
          ilike(expenseSubmissions.vendor, likePattern(qParam)),
          ilike(expenseSubmissions.description, likePattern(qParam)),
          ilike(expenseSubmissions.project_tag, likePattern(qParam)),
          ilike(expenseSubmissions.invoice_number, likePattern(qParam)),
          ilike(expenseSubmissions.department, likePattern(qParam)),
          ilike(expenseSubmissions.bucket, likePattern(qParam)),
          ilike(users.name, likePattern(qParam)),
          sql`${expenseSubmissions.amount}::text ILIKE ${likePattern(qParam)}`,
        )
      : undefined;

    const where = and(
      ...baseConds,
      deptFilter,
      bucketFilter,
      projectFilter,
      vendorFilter,
      searchFilter,
    );

    /**
     * Grouped on the RAW column, with NULL folded to "unassigned" in TS below.
     *
     * Doing the COALESCE in SQL would bind the fallback as a parameter, and
     * Drizzle serialises the same fragment as $1 in SELECT and $2 in GROUP BY —
     * which Postgres does not treat as the same expression, so it rejects the
     * grouping outright. Same reason the buckets route groups this way.
     *
     * No cap here. This is what the summary rows and the grand total are built
     * from, so they stay correct however many rows the list below is showing.
     */
    const deptRowsQ = db
      .select({
        department: expenseSubmissions.department,
        total: sql<string>`COALESCE(SUM(${expenseSubmissions.amount}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(expenseSubmissions)
      // Joined for ?q= alone, which searches the submitter's name. Safe for
      // COUNT(*): users.id is the primary key, so this matches at most one row
      // and cannot fan the group out. Joined unconditionally rather than only
      // when searching, to keep one query and one plan.
      .leftJoin(users, eq(expenseSubmissions.submitted_by, users.id))
      .where(where)
      .groupBy(expenseSubmissions.department);

    // The same 11 fields the panel has always rendered.
    const rowsQ = db
      .select({
        id: expenseSubmissions.id,
        vendor: expenseSubmissions.vendor,
        amount: expenseSubmissions.amount,
        description: expenseSubmissions.description,
        department: expenseSubmissions.department,
        bucket: expenseSubmissions.bucket,
        project_tag: expenseSubmissions.project_tag,
        expense_date: expenseSubmissions.expense_date,
        bill_url: expenseSubmissions.bill_url,
        created_at: expenseSubmissions.created_at,
        submitter_name: users.name,
      })
      .from(expenseSubmissions)
      .leftJoin(users, eq(expenseSubmissions.submitted_by, users.id))
      .where(where)
      // By the day the money was spent, with created_at breaking ties so the
      // order is stable between requests.
      .orderBy(desc(effectiveDate), desc(expenseSubmissions.created_at))
      // One extra row is a probe: if it comes back, there is more behind it.
      .limit(ROW_CAP + 1);

    /**
     * Options for the project and vendor dropdowns.
     *
     * Each is scoped by the window and by the OTHER filters, so the two cascade
     * — picking a department narrows both lists — but never by itself, which
     * would collapse a dropdown to the single option already chosen.
     *
     * Separate queries rather than a distinct over `rows`, because options
     * derived from a capped list would quietly omit every vendor whose invoices
     * fell off the end of it. The panel used to derive them exactly that way.
     */
    const vendorRowsQ = db
      .selectDistinct({ vendor: expenseSubmissions.vendor })
      .from(expenseSubmissions)
      .leftJoin(users, eq(expenseSubmissions.submitted_by, users.id))
      .where(
        and(
          ...baseConds,
          isNotNull(expenseSubmissions.vendor),
          deptFilter,
          bucketFilter,
          projectFilter,
          // The search DOES apply here: an option the search has excluded would
          // return nothing if picked.
          searchFilter,
        ),
      )
      .orderBy(expenseSubmissions.vendor);

    const projectRowsQ = db
      .selectDistinct({ project_tag: expenseSubmissions.project_tag })
      .from(expenseSubmissions)
      .leftJoin(users, eq(expenseSubmissions.submitted_by, users.id))
      .where(
        and(
          ...baseConds,
          isNotNull(expenseSubmissions.project_tag),
          deptFilter,
          bucketFilter,
          vendorFilter,
          searchFilter,
        ),
      )
      .orderBy(expenseSubmissions.project_tag);

    const [deptRows, fetchedRows, vendorRows, projectRows] = await Promise.all([
      deptRowsQ,
      rowsQ,
      vendorRowsQ,
      projectRowsQ,
    ]);

    // "unassigned" is the synthetic key for a NULL department: the filter sends
    // it back and this route turns it into IS NULL, so a row nobody has
    // classified stays reachable instead of being findable only by not
    // filtering at all.
    const departments = deptRows
      .map((r) => ({
        key: r.department ?? UNASSIGNED_DEPARTMENT_KEY,
        label: expenseDepartmentLabel(r.department),
        total: Number(r.total || 0),
        count: Number(r.count || 0),
      }))
      .sort((a, b) => b.total - a.total);

    // Summed from the grouped rows rather than with a fourth query, so the parts
    // and the whole cannot disagree — the property that makes the split
    // trustworthy.
    const grandTotal = departments.reduce((sum, d) => sum + d.total, 0);
    const grandCount = departments.reduce((sum, d) => sum + d.count, 0);

    const capped = fetchedRows.length > ROW_CAP;

    return NextResponse.json({
      success: true,
      data: {
        period,
        label,
        departments,
        grandTotal,
        grandCount,
        rows: capped ? fetchedRows.slice(0, ROW_CAP) : fetchedRows,
        vendors: vendorRows
          .map((v) => v.vendor)
          .filter((v): v is string => Boolean(v)),
        projects: projectRows
          .map((p) => p.project_tag)
          .filter((p): p is string => Boolean(p)),
        capped,
        cap: ROW_CAP,
      },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
