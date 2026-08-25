/**
 * Repair a lead dispatched BEFORE the E-266 warranty fix and the EMI-amount
 * fix in projectDisbursedLoan.
 *
 * What it corrects, for ONE lead at a time:
 *   1. deployed_assets — rows whose warranty ended on (or before) the day they
 *      started, i.e. written with 0 months. Recomputes `warranty_end_date` from
 *      `warranty_start_date` + the duration `resolveWarrantyMonths` picks
 *      (inventory → product → OEM → 24) and stamps `warranty_months`.
 *      Rows that already have a future end date are left alone.
 *   2. emi_schedules — rows on the lead's disbursed sanction whose `amount` or
 *      `emi_seq` is NULL. Backfills `amount = loan_sanctions.emi` and
 *      `emi_seq` by due-date order. Rows with an amount are left alone.
 *
 * Dry run by default — prints what WOULD change. Add `--apply` to write.
 *
 *   node --env-file=.env.local --import tsx scripts/repair-dispatched-warranty-emi.ts -- --lead LEAD-...
 *   node --env-file=.env.local --import tsx scripts/repair-dispatched-warranty-emi.ts -- --lead LEAD-... --apply
 *
 * Deliberately not a bulk sweep: the historical end date is what the customer
 * was told, so widening it is a per-case decision.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { and, asc, desc, eq, isNull, or } from "drizzle-orm";

import { db } from "../src/lib/db";
import {
  afterSalesRecords,
  deployedAssets,
  emiSchedules,
  inventory,
  loanSanctions,
  products,
} from "../src/lib/db/schema";
import { resolveWarrantyMonths } from "../src/lib/sales/sale-finalization";

function parseArgs(): { lead?: string; apply: boolean } {
  const out: { lead?: string; apply: boolean } = { apply: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lead") out.lead = argv[++i];
    else if (argv[i] === "--apply") out.apply = true;
  }
  return out;
}

async function main() {
  const { lead, apply } = parseArgs();
  if (!lead) {
    console.error("Usage: --lead <LEAD-id> [--apply]");
    process.exit(1);
  }
  console.log(`${apply ? "APPLY" : "DRY RUN"} — lead ${lead} on ${new URL(process.env.DATABASE_URL ?? "postgres://x/x").host}`);

  // ---- 1. Warranty -------------------------------------------------------
  const asr = await db
    .select({ warranty_id: afterSalesRecords.warranty_id, serial: afterSalesRecords.battery_serial })
    .from(afterSalesRecords)
    .where(eq(afterSalesRecords.lead_id, lead));

  if (asr.length === 0) console.log("No after_sales_records for this lead — nothing to repair on warranty.");

  for (const a of asr) {
    if (!a.warranty_id) continue;
    const [da] = await db
      .select({
        id: deployedAssets.id,
        serial: deployedAssets.serial_number,
        start: deployedAssets.warranty_start_date,
        end: deployedAssets.warranty_end_date,
        months: deployedAssets.warranty_months,
      })
      .from(deployedAssets)
      .where(eq(deployedAssets.id, a.warranty_id))
      .limit(1);
    if (!da || !da.start) continue;

    const broken = !da.end || da.end.getTime() <= da.start.getTime() + 24 * 3600 * 1000;
    if (!broken && da.months) {
      console.log(`warranty ${da.id} (${da.serial}): OK — ${da.months} months, until ${da.end?.toISOString()}`);
      continue;
    }

    const [inv] = await db
      .select({
        inventory_warranty_months: inventory.warranty_months,
        oem_warranty_months: inventory.oem_warranty_months,
        product_warranty_months: products.warranty_months,
      })
      .from(inventory)
      .leftJoin(products, eq(inventory.product_id, products.id))
      .where(eq(inventory.serial_number, da.serial ?? a.serial ?? ""))
      .limit(1);

    const months = resolveWarrantyMonths(inv ?? {});
    const newEnd = new Date(da.start);
    newEnd.setMonth(newEnd.getMonth() + months);

    if (!broken) {
      // Dates fine, only the months column is missing.
      console.log(`warranty ${da.id} (${da.serial}): stamp warranty_months=${months} (dates unchanged)`);
      if (apply) await db.update(deployedAssets).set({ warranty_months: months, updated_at: new Date() }).where(eq(deployedAssets.id, da.id));
      continue;
    }

    console.log(
      `warranty ${da.id} (${da.serial}): end ${da.end?.toISOString() ?? "NULL"} → ${newEnd.toISOString()} (${months} months)`,
    );
    if (apply) {
      await db
        .update(deployedAssets)
        .set({ warranty_end_date: newEnd, warranty_months: months, warranty_status: "active", updated_at: new Date() })
        .where(eq(deployedAssets.id, da.id));
    }
  }

  // ---- 2. EMI schedule ---------------------------------------------------
  const [loan] = await db
    .select({ id: loanSanctions.id, emi: loanSanctions.emi, status: loanSanctions.status, nbfc_id: loanSanctions.nbfc_id })
    .from(loanSanctions)
    .where(eq(loanSanctions.lead_id, lead))
    .orderBy(desc(loanSanctions.created_at))
    .limit(1);

  if (!loan) {
    console.log("No loan_sanctions row — cash lead or not sanctioned; EMI step skipped.");
  } else {
    const emi = Number(loan.emi);
    const amount = Number.isFinite(emi) && emi > 0 ? emi.toFixed(2) : null;
    console.log(`loan ${loan.id}: status=${loan.status} nbfc_id=${loan.nbfc_id ?? "NULL"} emi=${loan.emi ?? "NULL"}`);
    if (!loan.nbfc_id) console.log("  ⚠ nbfc_id is NULL — this loan is not projected into nbfc_loans and will not appear in the NBFC portal.");

    const rows = await db
      .select({ id: emiSchedules.id, due: emiSchedules.due_date, seq: emiSchedules.emi_seq, amount: emiSchedules.amount })
      .from(emiSchedules)
      .where(and(eq(emiSchedules.loan_sanction_id, loan.id), or(isNull(emiSchedules.amount), isNull(emiSchedules.emi_seq))))
      .orderBy(asc(emiSchedules.due_date));

    if (rows.length === 0) console.log("  emi_schedules: nothing to backfill.");
    // Sequence by position across the WHOLE schedule, not just the null rows.
    const all = await db
      .select({ id: emiSchedules.id })
      .from(emiSchedules)
      .where(eq(emiSchedules.loan_sanction_id, loan.id))
      .orderBy(asc(emiSchedules.due_date));
    const seqOf = new Map(all.map((r, i) => [r.id, i + 1]));

    for (const r of rows) {
      const seq = r.seq ?? seqOf.get(r.id) ?? null;
      console.log(`  emi ${r.due}: seq ${r.seq ?? "NULL"}→${seq}, amount ${r.amount ?? "NULL"}→${amount ?? "NULL"}`);
      if (apply) {
        await db
          .update(emiSchedules)
          .set({ emi_seq: seq, amount: r.amount ?? amount })
          .where(eq(emiSchedules.id, r.id));
      }
    }
  }

  console.log(apply ? "Done." : "Dry run only — re-run with --apply to write.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
