/**
 * E-217 — reconvert foreign-currency expense rows that were imported before
 * conversion existed.
 *
 * Run: node --import tsx --env-file=.env.local scripts/_backfill-expense-currency.ts [--apply]
 *
 * Without --apply it only reports. E-216 stored a foreign invoice's face value
 * straight into `amount`, so a $200 bill sits in the rupee total as ₹200. This
 * finds those rows (currency from ai_raw), converts at the rate for the
 * invoice's own date, and rewrites amount / original_amount / fx_*.
 *
 * Idempotent: a row already carrying a real fx_rate is left alone, so the
 * script can be re-run after a partial pass.
 */
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { convertToInr } from "@/lib/expenses/fx";

const APPLY = process.argv.includes("--apply");

async function main() {
  // Rows whose extracted currency is not INR and which have not been converted
  // yet (fx_source 'none' is the migration's rupee backfill).
  const rows = await db
    .select({
      id: expenseSubmissions.id,
      file_name: expenseSubmissions.file_name,
      vendor: expenseSubmissions.vendor,
      amount: expenseSubmissions.amount,
      expense_date: expenseSubmissions.expense_date,
      currency: expenseSubmissions.currency,
      fx_source: expenseSubmissions.fx_source,
      raw_currency: sql<string | null>`${expenseSubmissions.ai_raw}->>'currency'`,
    })
    .from(expenseSubmissions)
    .where(
      and(
        isNotNull(expenseSubmissions.drive_file_id),
        sql`COALESCE(${expenseSubmissions.ai_raw}->>'currency', 'INR') <> 'INR'`,
        or(
          eq(expenseSubmissions.fx_source, "none"),
          sql`${expenseSubmissions.fx_source} IS NULL`,
        ),
      ),
    );

  if (rows.length === 0) {
    console.log("Nothing to convert — no unconverted foreign-currency rows.");
    process.exit(0);
  }

  console.log(`${rows.length} row(s) to convert${APPLY ? "" : "  (dry run — pass --apply to write)"}\n`);

  let deltaInr = 0;
  for (const r of rows) {
    const code = (r.raw_currency ?? r.currency ?? "").toUpperCase();
    const face = Number(r.amount);
    const fx = await convertToInr(face, code, r.expense_date);
    deltaInr += fx.amountInr - face;

    console.log(
      `  ${(r.file_name ?? r.id).padEnd(32)} ${code} ${String(face).padStart(9)}` +
        ` @ ${String(fx.rate).padStart(10)} (${fx.rateDate ?? "n/a"}, ${fx.source})` +
        ` -> INR ${fx.amountInr.toFixed(2)}`,
    );
    if (fx.warning) console.log(`      ! ${fx.warning}`);

    if (APPLY) {
      await db
        .update(expenseSubmissions)
        .set({
          amount: fx.amountInr.toFixed(2),
          original_amount: face.toFixed(2),
          currency: code,
          fx_rate: String(fx.rate),
          fx_rate_date: fx.rateDate,
          fx_source: fx.source,
          needs_attention: fx.warning ? true : false,
          attention_reason: fx.warning ?? null,
          updated_at: new Date(),
        })
        .where(eq(expenseSubmissions.id, r.id));
    }
  }

  console.log(
    `\nExpense total ${APPLY ? "increased" : "would increase"} by INR ${deltaInr.toFixed(2)}`,
  );
  if (!APPLY) console.log("Re-run with --apply to write these changes.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
