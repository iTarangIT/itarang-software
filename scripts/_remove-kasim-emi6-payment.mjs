// Remove the erroneous 19/6/2026 cash payment on Kasim's installment 6
// (LS-IMPORT-3 / TK-51105-07KY-161952). Per the source sheet Kasim has made
// only 5 EMIs (Feb–Jun); the 6th (due 28 Jun) is not yet paid.
//
// Reverses everything applyEmiPayment wrote for that payment:
//   1. emi_schedules seq 6 → back to 'scheduled' (paid_at/ref/mode/amount_paid cleared)
//   2. emi_payment_attempts → delete the cash attempt (printed first for recovery)
//   3. nbfc_loans.outstanding_amount → recomputed = loan_amount - paid_count*emi
// The immutable nbfc_audit_log row is intentionally NOT touched.
//
// Usage:
//   node scripts/_remove-kasim-emi6-payment.mjs --dry   # preview
//   node scripts/_remove-kasim-emi6-payment.mjs         # apply
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv(join(ROOT,".env.local"));

const DRY = process.argv.includes("--dry");
const LOAN = "LS-IMPORT-3";
const TARGET_SEQ = 6;

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const host = (process.env.DATABASE_URL || "").replace(/.*@/, "").split(/[:/]/)[0];
console.log(`Host: ${host}`);
console.log(`Mode: ${DRY ? "DRY-RUN (no writes)" : "APPLY"}\n`);

const [loan] = (await c.query(
  `SELECT loan_application_id, emi_amount, outstanding_amount FROM nbfc_loans WHERE loan_application_id=$1`,
  [LOAN],
)).rows;
const [sanction] = (await c.query(
  `SELECT loan_amount, status FROM loan_sanctions WHERE id=$1`, [LOAN],
)).rows;
const emiAmt = Number(loan.emi_amount);
const loanAmt = Number(sanction.loan_amount);
console.log(`Loan ${LOAN}: emi=${emiAmt} loan_amount=${loanAmt} outstanding(before)=${loan.outstanding_amount} status=${sanction.status}`);

const [row6] = (await c.query(
  `SELECT id, emi_seq, due_date, paid_at, status, days_overdue, amount_paid, payment_ref, collection_mode, attempt_count
   FROM emi_schedules WHERE loan_sanction_id=$1 AND emi_seq=$2`,
  [LOAN, TARGET_SEQ],
)).rows;
if (!row6) { console.error(`No installment seq ${TARGET_SEQ} found.`); process.exit(1); }
console.log(`\nInstallment ${TARGET_SEQ} (before):`, JSON.stringify({
  due: String(row6.due_date).slice(0,10),
  paid_at: row6.paid_at ? new Date(row6.paid_at).toISOString().slice(0,10) : null,
  status: row6.status, days_overdue: row6.days_overdue,
  amount_paid: row6.amount_paid, payment_ref: row6.payment_ref, collection_mode: row6.collection_mode,
}, null, 2));

const attempts = (await c.query(
  `SELECT id, emi_schedule_id, mode, channel, status, amount_paise, reference_no, collected_at, created_at
   FROM emi_payment_attempts WHERE loan_sanction_id=$1`, [LOAN],
)).rows;
console.log(`\nemi_payment_attempts to DELETE (${attempts.length}) — saved here for recovery:`);
console.table(attempts.map(a => ({ id: a.id, mode: a.mode, channel: a.channel, status: a.status, rupees: a.amount_paise/100, ref: a.reference_no, created: new Date(a.created_at).toISOString().slice(0,10) })));

if (row6.status !== "paid" && row6.status !== "paid_late" && attempts.length === 0) {
  console.log("\nAlready removed — nothing to do.");
  await c.end(); process.exit(0);
}

// New outstanding = loan_amount - (paid installments after removal) * emi.
const paidAfter = (await c.query(
  `SELECT count(*)::int n FROM emi_schedules
   WHERE loan_sanction_id=$1 AND emi_seq <> $2 AND status IN ('paid','paid_late')`,
  [LOAN, TARGET_SEQ],
)).rows[0].n;
const newOutstanding = Math.max(0, loanAmt - paidAfter * emiAmt);
console.log(`\nPaid installments after removal: ${paidAfter} → new outstanding = ${newOutstanding}`);
console.log(`Installment ${TARGET_SEQ} (after): status='scheduled', paid_at=null, days_overdue=null, amount_paid=null, ref=null, mode=null`);

if (DRY) { console.log("\nDRY-RUN — no writes. Re-run without --dry to apply."); await c.end(); process.exit(0); }

await c.query("BEGIN");
try {
  await c.query(
    `UPDATE emi_schedules
       SET status='scheduled', paid_at=NULL, days_overdue=NULL, amount_paid='0.00',
           payment_ref=NULL, collection_mode=NULL, attempt_count=0
     WHERE id=$1`,
    [row6.id],
  );
  await c.query(`DELETE FROM emi_payment_attempts WHERE loan_sanction_id=$1`, [LOAN]);

  // Correct the off-by-one days_overdue on installments 2-5 (read due_date as
  // text so we compute against the real due date, not a TZ-shifted Date).
  const fixDpd = (await c.query(
    `SELECT id, emi_seq, due_date::text AS due, paid_at::text AS paid, days_overdue
     FROM emi_schedules
     WHERE loan_sanction_id=$1 AND emi_seq IN (2,3,4,5) AND paid_at IS NOT NULL`,
    [LOAN],
  )).rows;
  const DAY = 86_400_000;
  for (const r of fixDpd) {
    const dpd = Math.max(0, Math.round(
      (Date.parse(`${r.paid.slice(0,10)}T00:00:00Z`) - Date.parse(`${r.due.slice(0,10)}T00:00:00Z`)) / DAY,
    ));
    if (dpd !== r.days_overdue) {
      await c.query(`UPDATE emi_schedules SET days_overdue=$1 WHERE id=$2`, [dpd, r.id]);
      console.log(`  seq ${r.emi_seq}: days_overdue ${r.days_overdue} → ${dpd}`);
    }
  }
  await c.query(
    `UPDATE nbfc_loans SET outstanding_amount=$1, current_dpd=0, updated_at=NOW() WHERE loan_application_id=$2`,
    [newOutstanding.toFixed(2), LOAN],
  );
  await c.query("COMMIT");
  console.log(`\n✓ Removed installment-${TARGET_SEQ} payment. Outstanding → ${newOutstanding}. Audit log left intact.`);
} catch (e) {
  await c.query("ROLLBACK");
  console.error("ROLLBACK —", e.message);
  process.exit(1);
}
await c.end();
