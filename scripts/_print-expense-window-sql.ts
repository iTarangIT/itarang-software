/**
 * E-214 — print the SQL that `approvedExpenseInWindow` generates.
 *
 * Run: node --import tsx --env-file=.env.local scripts/_print-expense-window-sql.ts
 *
 * Read-only: `.toSQL()` renders the statement without executing it. Exists
 * because the whole point of the OR form is that it compares PLAIN COLUMNS
 * against constants — if a COALESCE or a ::date cast crept back into the WHERE
 * clause, the indexes silently stop being used and nothing would fail loudly.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { approvedExpenseInWindow } from "@/lib/dashboard/salesWindow";

function show(label: string, start: string, end: string | null) {
  const q = db
    .select({ total: sql<string>`COALESCE(SUM(${expenseSubmissions.amount}), 0)` })
    .from(expenseSubmissions)
    .where(approvedExpenseInWindow(start, end));
  const { sql: text, params } = q.toSQL();
  console.log(`\n=== ${label} ===`);
  console.log(text);
  console.log("params:", params);
}

show("month window (Mar 2026)", "2026-03-01", "2026-04-01");
show("open-ended FY window", "2025-04-01", null);
process.exit(0);
