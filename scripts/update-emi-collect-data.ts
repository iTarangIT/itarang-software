/**
 * Apply "EMI Collection Tech.xlsx" updates onto the already-imported
 * LS-IMPORT-* loans (see scripts/import-emi-collect-data.ts).
 *
 * The new sheet only changes the collection history for TWO accounts vs the
 * original "EMI Collect Data.xlsx":
 *   - Sami Ur Rehman (TK-51105-07KY-161951) — the old "Pending" 3rd-installment
 *     gap is now collected, so his 111-day overdue should drop sharply.
 *   - Pappu (TK-51105-07KY-161947) — 5th payment now explicitly recorded and a
 *     stale date-parse quirk is cleaned up.
 * The other four accounts are byte-identical in the new sheet (and Kasim carries
 * an app-recorded payment we must not disturb), and Ali Khan is absent — so we
 * deliberately touch ONLY the two changed batteries, matched by serial.
 *
 * For each: reset its emi_schedules rows to 'scheduled', overlay the new
 * collection history positionally (i-th collection → i-th installment, exactly
 * like the import), then recompute nbfc_loans.outstanding_amount + current_dpd.
 *
 * TODAY is pinned to 2026-06-17 to stay consistent with the rest of the
 * imported dataset and scripts/score-imported-loans.ts.
 *
 * Idempotent — re-running re-derives the same end state. Re-run the scorer
 * afterwards (scripts/score-imported-loans.ts) to refresh CDS/PCI.
 *
 * Usage:
 *   tsx scripts/update-emi-collect-data.ts --dry   # parse + print, no writes
 *   tsx scripts/update-emi-collect-data.ts         # apply
 */
import "./_load-env";
import path from "node:path";
import xlsx from "xlsx";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emiSchedules, nbfcLoans, loanSanctions } from "@/lib/db/schema";

const XLSX_PATH = "C:/Users/Aniket/Downloads/EMI Collection Tech.xlsx";
const TENANT_ID = "02bda647-c164-4e81-809b-01cfe159cdb6"; // iTarang Finance
const TODAY = new Date(Date.UTC(2026, 5, 17)); // 2026-06-17 — matches the import + scorer clock
const DRY = process.argv.includes("--dry");

// Only these batteries differ in the new sheet — touch nothing else.
const CHANGED_BATTERIES = new Set([
  "TK-51105-07KY-161951", // Sami Ur Rehman
  "TK-51105-07KY-161947", // Pappu
]);

// ── parse helpers (same semantics as import-emi-collect-data.ts) ──────────────
function serialToDate(n: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000);
}
function parseDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? serialToDate(v) : null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (!m) return null;
  const day = +m[1];
  const month = +m[2];
  let year = +m[3];
  if (year < 100) year += 2000;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}
const PAID_BY_DEALER = /dealer\s*(paid|collected)/i;
function parseCollected(v: unknown): { paid: boolean; amount: number | null } {
  if (v == null || v === "") return { paid: false, amount: null };
  // A numeric cell counts as a collection only when > 0. The new sheet uses a
  // literal 0 (paired with an "Overdue" date) to mark UNcollected installments.
  if (typeof v === "number")
    return Number.isFinite(v) && v > 0 ? { paid: true, amount: v } : { paid: false, amount: null };
  const s = String(v).trim();
  const num = s.match(/(\d[\d,]*\.?\d*)/);
  const amount = num ? Number(num[1].replace(/,/g, "")) : null;
  if (amount != null && amount > 0) return { paid: true, amount };
  if (PAID_BY_DEALER.test(s)) return { paid: true, amount: null };
  return { paid: false, amount: null };
}
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// The new sheet repeats the header "EMI Collect Date" for every pair, so
// sheet_to_json suffixes the dupes _1.._6. Amount/date columns are paired.
const COLLECT_COLS: [string, string][] = [
  ["1st Amount Collected", "EMI Collect Date"],
  ["2nd Amount Collected", "EMI Collect Date_1"],
  ["3rd Amount Collected", "EMI Collect Date_2"],
  ["4th Amount Collected", "EMI Collect Date_3"],
  ["5th  Amount Collected", "EMI Collect Date_4"],
  ["6th Amount Collected", "EMI Collect Date_5"],
  ["7th Amount Collected", "EMI Collect Date_6"],
];

interface Collected {
  amount: number | null;
  date: Date | null;
}

async function main() {
  const host = (process.env.DATABASE_URL || "").match(/@([^/:]+)/)?.[1];
  console.log(`DB host: ${host}`);
  console.log(`Mode: ${DRY ? "DRY-RUN (no writes)" : "APPLY"}\n`);

  const wb = xlsx.readFile(path.normalize(XLSX_PATH));
  const raw = xlsx.utils.sheet_to_json<Record<string, unknown>>(
    wb.Sheets[wb.SheetNames[0]],
    { defval: null },
  );

  for (const r of raw) {
    const battery = r["Battery No"] ? String(r["Battery No"]).trim() : null;
    if (!battery || !CHANGED_BATTERIES.has(battery)) continue;

    const driver = String(r["Driver Name"] ?? "").trim();
    const loanAmount = num(r["Total Loan Amount"]);
    const emiAmount = num(r["Total EMI Amount"]);

    const collected: (Collected | null)[] = COLLECT_COLS.map(([amtCol, dateCol]) => {
      const c = parseCollected(r[amtCol]);
      if (!c.paid) return null;
      return { amount: c.amount ?? emiAmount, date: parseDate(r[dateCol]) };
    });

    // Resolve the loan via the servicing ledger's battery serial.
    const [ledger] = await db
      .select({ id: nbfcLoans.loan_application_id })
      .from(nbfcLoans)
      .where(
        sql`${nbfcLoans.tenant_id} = ${TENANT_ID} AND ${nbfcLoans.vehicleno} = ${battery}`,
      )
      .limit(1);
    if (!ledger) {
      console.warn(`! ${driver} (${battery}): no nbfc_loans row — skipped.`);
      continue;
    }
    const lsId = ledger.id;

    const schedule = await db
      .select()
      .from(emiSchedules)
      .where(eq(emiSchedules.loan_sanction_id, lsId))
      .orderBy(asc(emiSchedules.due_date));

    let totalCollected = 0;
    let maxDpd = 0;
    const preview: string[] = [];

    const updates: { id: string; set: Record<string, unknown> }[] = [];
    for (let i = 0; i < schedule.length; i++) {
      const row = schedule[i];
      const dueDate = new Date(`${row.due_date}T00:00:00Z`);
      const paid = collected[i];

      if (paid) {
        const paidDate = paid.date ?? dueDate;
        const overdue = Math.max(
          0,
          Math.round((paidDate.getTime() - dueDate.getTime()) / 86_400_000),
        );
        totalCollected += paid.amount ?? emiAmount ?? 0;
        updates.push({
          id: row.id,
          set: {
            status: overdue > 0 ? "paid_late" : "paid",
            paid_at: paidDate,
            days_overdue: overdue,
          },
        });
        preview.push(
          `  ${row.due_date}  ${overdue > 0 ? "paid_late" : "paid"} (paid ${paidDate.toISOString().slice(0, 10)}, dpd ${overdue})`,
        );
      } else if (dueDate.getTime() < TODAY.getTime()) {
        const dpd = Math.round((TODAY.getTime() - dueDate.getTime()) / 86_400_000);
        maxDpd = Math.max(maxDpd, dpd);
        updates.push({
          id: row.id,
          set: { status: "overdue", paid_at: null, days_overdue: dpd },
        });
        preview.push(`  ${row.due_date}  overdue (dpd ${dpd})`);
      } else {
        updates.push({
          id: row.id,
          set: { status: "scheduled", paid_at: null, days_overdue: null },
        });
        preview.push(`  ${row.due_date}  scheduled`);
      }
    }

    const outstanding = Math.max(0, (loanAmount ?? 0) - totalCollected);
    console.log(
      `● ${driver} (${battery}) → ${lsId}\n  collected=${totalCollected} outstanding=${outstanding} current_dpd=${maxDpd}`,
    );
    preview.forEach((p) => console.log(p));

    if (!DRY) {
      await db.transaction(async (tx) => {
        for (const u of updates) {
          await tx.update(emiSchedules).set(u.set).where(eq(emiSchedules.id, u.id));
        }
        await tx
          .update(nbfcLoans)
          .set({
            outstanding_amount: outstanding.toString(),
            current_dpd: maxDpd,
            updated_at: new Date(),
          })
          .where(eq(nbfcLoans.loan_application_id, lsId));
        // Keep loan_amount/emi authoritative (unchanged in the new sheet, but
        // re-assert so a corrected sheet would propagate).
        await tx
          .update(loanSanctions)
          .set({
            loan_amount: loanAmount?.toString() ?? null,
            emi: emiAmount?.toString() ?? null,
          })
          .where(eq(loanSanctions.id, lsId));
      });
      console.log("  ✓ applied\n");
    } else {
      console.log("");
    }
  }

  console.log(
    DRY
      ? "DRY-RUN complete — no writes. Re-run without --dry to apply."
      : "Done. Now re-run: tsx scripts/score-imported-loans.ts to refresh CDS/PCI.",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
