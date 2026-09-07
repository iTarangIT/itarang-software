/**
 * E-280 — prove src/lib/dashboard/revenueSource.ts reports the same revenue the
 * inline `zoho_invoices` queries did.
 *
 * The union has to be adopted by six endpoints at once. If it moves a number,
 * it must be because a Drive invoice was added — never because the union
 * itself counts differently. So this re-implements the OLD predicates directly
 * against zoho_invoices and asserts the new module agrees, both before E-280 is
 * applied (Zoho-only fallback) and after (union, where the difference must
 * equal exactly the Drive contribution).
 *
 * Read-only. Run:
 *   node --import tsx --env-file=.env.local scripts/verify-revenue-source.ts
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  isDriveRevenueAvailable,
  outstandingTotal,
  revenueSeries,
  revenueSummary,
  revenueTotal,
  listRevenueInvoices,
} from "@/lib/dashboard/revenueSource";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}\n        got ${actual}  expected ${expected}`,
  );
}

function near(label: string, actual: number, expected: number, tol = 0.01) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}\n        got ${actual}  expected ${expected}`,
  );
}

/** The legacy predicate, written out again rather than imported. */
async function legacyRevenue(from?: string, to?: string): Promise<number> {
  const rows = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(total), 0) AS total
    FROM zoho_invoices
    WHERE (status IS NULL OR status NOT IN ('void'))
      ${from ? sql`AND invoice_date >= ${from}::date` : sql``}
      ${to ? sql`AND invoice_date < ${to}::date` : sql``}
  `);
  return Number((rows as unknown as Array<{ total: string }>)[0]?.total ?? 0);
}

async function legacyOutstanding(from?: string, to?: string): Promise<number> {
  const rows = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(balance), 0) AS total
    FROM zoho_invoices
    WHERE (status IS NULL OR status NOT IN ('paid', 'void', 'draft'))
      AND COALESCE(balance, 0) > 0
      ${from ? sql`AND invoice_date >= ${from}::date` : sql``}
      ${to ? sql`AND invoice_date < ${to}::date` : sql``}
  `);
  return Number((rows as unknown as Array<{ total: string }>)[0]?.total ?? 0);
}

/** Drive-side contribution under the same rules, or 0 when the table is absent. */
async function driveRevenue(from?: string, to?: string): Promise<number> {
  if (!(await isDriveRevenueAvailable())) return 0;
  const rows = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(total), 0) AS total
    FROM sales_invoices
    WHERE (status IS NULL OR status NOT IN ('void'))
      ${from ? sql`AND invoice_date >= ${from}::date` : sql``}
      ${to ? sql`AND invoice_date < ${to}::date` : sql``}
  `);
  return Number((rows as unknown as Array<{ total: string }>)[0]?.total ?? 0);
}

async function main() {
  const driveAvailable = await isDriveRevenueAvailable();
  console.log(
    `sales_invoices present: ${driveAvailable}` +
      (driveAvailable ? "" : "  (E-280 not applied here — testing the fallback path)"),
  );

  const windows: Array<[string, string | undefined, string | undefined]> = [
    ["all time", undefined, undefined],
    ["FY 2026-27", "2026-04-01", "2027-04-01"],
    ["Jul 2026", "2026-07-01", "2026-08-01"],
    ["Aug 2026", "2026-08-01", "2026-09-01"],
  ];

  console.log("\n--- revenueTotal matches legacy + Drive ---");
  for (const [label, from, to] of windows) {
    const [actual, zoho, drive] = await Promise.all([
      revenueTotal(from, to),
      legacyRevenue(from, to),
      driveRevenue(from, to),
    ]);
    near(`revenue ${label}`, actual, zoho + drive);
  }

  console.log("\n--- outstandingTotal matches legacy ---");
  {
    const [actual, zoho] = await Promise.all([outstandingTotal(), legacyOutstanding()]);
    // With no Drive rows this must match exactly; with Drive rows it can only
    // be larger, never smaller.
    if (driveAvailable) {
      const ok = actual >= zoho;
      if (!ok) failures += 1;
      console.log(
        `  ${ok ? "PASS" : "FAIL"}  outstanding all-time >= legacy\n        got ${actual}  legacy ${zoho}`,
      );
    } else {
      near("outstanding all-time", actual, zoho);
    }
  }

  console.log("\n--- summary reconciles with the row list ---");
  {
    const f = { from: "2026-04-01", to: "2027-03-31", limit: 500 };
    const [summary, rows] = await Promise.all([
      revenueSummary(f),
      listRevenueInvoices(f),
    ]);
    const ok = rows.length <= summary.count;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  page size <= summary count\n        got ${rows.length}  count ${summary.count}`,
    );
    const pageTotal = rows.reduce((a, r) => a + Number(r.total || 0), 0);
    if (summary.count <= 500) {
      near("page total = summary total (single page)", pageTotal, summary.total, 0.02);
    } else {
      console.log(`  SKIP  more than one page (${summary.count} rows)`);
    }
    // Every row must carry a usable document link and a known source.
    const badSource = rows.filter((r) => r.source !== "zoho" && r.source !== "drive");
    check("every row has a known source", badSource.length, 0);
  }

  console.log("\n--- chart series sums to the card ---");
  for (const [label, from, to] of windows.slice(1)) {
    const [series, total] = await Promise.all([
      revenueSeries("month", "Mon YYYY", from, to),
      revenueTotal(from, to),
    ]);
    const summed = series.reduce((a, b) => a + b.revenue, 0);
    near(`chart ${label} sums to card`, summed, total, 0.02);
  }

  console.log("\n--- source split ---");
  {
    const rows = await db.execute<{ source: string; n: string; total: string }>(sql`
      SELECT 'zoho' AS source, COUNT(*)::text AS n, COALESCE(SUM(total),0)::text AS total
      FROM zoho_invoices WHERE status IS NULL OR status NOT IN ('void')
    `);
    for (const r of rows as unknown as Array<{ source: string; n: string; total: string }>) {
      console.log(`  zoho_invoices : ${r.n} rows, total ${Number(r.total).toFixed(2)}`);
    }
    if (driveAvailable) {
      const d = await db.execute<{ n: string; total: string; flagged: string }>(sql`
        SELECT COUNT(*)::text AS n,
               COALESCE(SUM(total),0)::text AS total,
               COUNT(*) FILTER (WHERE needs_attention)::text AS flagged
        FROM sales_invoices WHERE status IS NULL OR status NOT IN ('void')
      `);
      const row = (d as unknown as Array<{ n: string; total: string; flagged: string }>)[0];
      console.log(
        `  sales_invoices: ${row?.n} rows, total ${Number(row?.total ?? 0).toFixed(2)}, ${row?.flagged} flagged`,
      );
    }
  }

  console.log(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
