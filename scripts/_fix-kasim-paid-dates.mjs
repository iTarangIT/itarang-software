// Fix Kasim (LS-IMPORT-3 / TK-51105-07KY-161952) swapped EMI paid_at dates.
//
// Import stored DD/MM source dates with day/month transposed for installments
// 2-5 (e.g. 02/03/2026 "2 Mar" became 2026-02-03 "3 Feb"). Correct them to the
// authoritative dates from the EMI sheet, then recompute days_overdue + status
// from the row's actual due_date.
//
// Installment 1 (02/02 — swap-invariant) and installment 6 (real app-recorded
// 19 Jun cash payment) are deliberately NOT touched.
//
// Idempotent: targets are fixed dates keyed by emi_seq; re-running is a no-op.
//
// Usage:
//   node scripts/_fix-kasim-paid-dates.mjs --dry   # show planned changes
//   node scripts/_fix-kasim-paid-dates.mjs         # apply
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv(join(ROOT,".env.local"));

const DRY = process.argv.includes("--dry");
const LOAN = "LS-IMPORT-3";

// Authoritative paid_at per installment sequence (YYYY-MM-DD), from the EMI sheet.
const CORRECT = { 2: "2026-03-02", 3: "2026-04-02", 4: "2026-05-02", 5: "2026-06-02" };

const DAY = 86_400_000;
const toUTC = (s) => new Date(`${s.slice(0,10)}T00:00:00Z`).getTime();

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const host = (process.env.DATABASE_URL || "").replace(/.*@/, "").split(/[:/]/)[0];
console.log(`Host: ${host}`);
console.log(`Mode: ${DRY ? "DRY-RUN (no writes)" : "APPLY"}\n`);

const sched = (await c.query(
  `SELECT id, emi_seq, due_date, paid_at, status, days_overdue
   FROM emi_schedules WHERE loan_sanction_id = $1 ORDER BY due_date ASC`,
  [LOAN],
)).rows;

const plan = [];
for (const r of sched) {
  const target = CORRECT[r.emi_seq];
  if (!target) continue; // only installments 2-5
  const due = r.due_date instanceof Date ? r.due_date.toISOString().slice(0,10) : String(r.due_date).slice(0,10);
  const dpd = Math.max(0, Math.round((toUTC(target) - toUTC(due)) / DAY));
  const status = dpd > 0 ? "paid_late" : "paid";
  const cur = r.paid_at ? new Date(r.paid_at).toISOString().slice(0,10) : null;
  plan.push({ id: r.id, seq: r.emi_seq, due, from: cur, to: target, status, dpd,
    changed: cur !== target || r.status !== status || (r.days_overdue ?? -1) !== dpd });
}

console.table(plan.map(p => ({ seq: p.seq, due: p.due, "paid_at_from": p.from, "paid_at_to": p.to, status: p.status, dpd: p.dpd, changed: p.changed })));

const toApply = plan.filter(p => p.changed);
if (toApply.length === 0) { console.log("\nNothing to change — already correct."); await c.end(); process.exit(0); }

if (DRY) { console.log(`\nDRY-RUN: ${toApply.length} row(s) would change. Re-run without --dry to apply.`); await c.end(); process.exit(0); }

await c.query("BEGIN");
try {
  for (const p of toApply) {
    await c.query(
      `UPDATE emi_schedules SET paid_at = $1::timestamptz, status = $2, days_overdue = $3 WHERE id = $4`,
      [`${p.to}T00:00:00Z`, p.status, p.dpd, p.id],
    );
  }
  await c.query("COMMIT");
  console.log(`\n✓ Applied ${toApply.length} correction(s) to ${LOAN}.`);
} catch (e) {
  await c.query("ROLLBACK");
  console.error("ROLLBACK —", e.message);
  process.exit(1);
}
await c.end();
