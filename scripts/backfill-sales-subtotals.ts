/**
 * E-280 — correct the tax-inclusive sub-totals already stored, and drop the
 * arithmetic warnings they caused.
 *
 * The extractor used to return Vyapar's payable amount as `sub_total`, with the
 * GST already inside it. `total` was right every time, so revenue was never
 * wrong — but `sub_total + tax_total` did not close, so validateSalesInvoice
 * flagged the invoice, and about half of the "needs a look" queue was these
 * false alarms.
 *
 * The scanner no longer produces them. This fixes the rows that already exist,
 * which a re-scan never will: an imported file is settled and is never read
 * again.
 *
 * For each row where `|sub_total - total| <= 2` and `tax_total > 0`:
 *   sub_total  := total - tax_total
 *   attention_reason := the same flags minus the arithmetic one
 *   needs_attention  := false when that was the only flag
 *
 * `total` is never touched — the figure revenue reads is not in question here.
 *
 * Dry run by default; pass --commit to write.
 *
 *   node --import tsx --env-file=.env.local      scripts/backfill-sales-subtotals.ts
 *   node --import tsx --env-file=.env.production scripts/backfill-sales-subtotals.ts --commit
 */
import postgres from "postgres";

import {
  formatAttentionReasons,
  parseAttentionReasons,
} from "../src/lib/sales/attentionReasons";

/** Same rupee tolerance validateSalesInvoice uses for per-line GST rounding. */
const TOLERANCE = 2;

const COMMIT = process.argv.includes("--commit");

interface Row {
  id: string;
  invoice_number: string | null;
  sub_total: string | null;
  tax_total: string | null;
  total: string | null;
  needs_attention: boolean;
  attention_reason: string | null;
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — pass --env-file=.env.local");

  const sql = postgres(url, { ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    const rows = (await sql`
      SELECT id, invoice_number, sub_total, tax_total, total, needs_attention, attention_reason
      FROM sales_invoices
      WHERE sub_total IS NOT NULL
        AND tax_total IS NOT NULL
        AND total IS NOT NULL
        AND tax_total > 0
        AND abs(sub_total - total) <= ${TOLERANCE}
        AND total - tax_total > 0
      ORDER BY invoice_date NULLS FIRST
    `) as unknown as Row[];

    if (rows.length === 0) {
      console.log("Nothing to correct — no row carries a tax-inclusive sub-total.");
      return;
    }

    console.log(
      `${rows.length} row(s) carry a tax-inclusive sub-total.` +
        (COMMIT ? " Writing." : " Dry run — nothing will be written.\n"),
    );

    let cleared = 0;
    let reworded = 0;

    for (const row of rows) {
      const total = Number(row.total);
      const tax = Number(row.tax_total);
      const corrected = Math.round((total - tax) * 100) / 100;

      const reasons = parseAttentionReasons(row.attention_reason);
      const kept = reasons.filter((r) => r.code !== "arithmetic_mismatch");
      const droppedOne = kept.length !== reasons.length;
      const rewritten = formatAttentionReasons(kept);
      const stillFlagged = row.needs_attention && kept.length > 0;

      console.log(
        `  ${(row.invoice_number ?? "(no number)").padEnd(16)} ` +
          `sub-total ${inr(Number(row.sub_total))} → ${inr(corrected)}` +
          (droppedOne ? "  · dropped the arithmetic warning" : "") +
          (row.needs_attention && !stillFlagged ? "  · flag cleared" : "") +
          (stillFlagged ? `  · still flagged: ${kept.map((k) => k.label).join(", ")}` : ""),
      );

      if (droppedOne) reworded += 1;
      if (row.needs_attention && !stillFlagged) cleared += 1;

      if (COMMIT) {
        await sql`
          UPDATE sales_invoices
          SET sub_total = ${corrected},
              attention_reason = ${rewritten},
              needs_attention = ${stillFlagged},
              updated_at = now()
          WHERE id = ${row.id}
        `;
      }
    }

    console.log(
      `\n${COMMIT ? "Wrote" : "Would write"} ${rows.length} sub-total(s); ` +
        `${reworded} arithmetic warning(s) removed; ${cleared} row(s) taken off the check list.`,
    );
    if (!COMMIT) console.log("Re-run with --commit to apply.");
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
