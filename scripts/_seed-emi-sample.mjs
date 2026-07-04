// Seed the EMI tracker with the sample loans from "EMI Collect Data.xlsx"
// (sheet "EMI Data"). Per loan it creates: a lead + a loan_sanction + an
// nbfc_loans bridge row + a full emi_schedules ledger, marking installments paid
// from the collection history and overdue/scheduled by due date.
//
// All rows carry an `EMI-SAMPLE-` id prefix and are scoped to the iTarang
// Finance tenant, so the seed is fully idempotent (it deletes its own prior rows
// first) and trivially removable. NOTHING else is touched. No real money — these
// are historical cash collections recorded against the schedule.
//
// Cleanup: re-run deletes+reinserts; to remove entirely run
//   node scripts/_seed-emi-sample.mjs --clean
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import xlsx from "xlsx";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv(join(ROOT,".env.local"));

const CLEAN_ONLY = process.argv.includes("--clean");
const XLSX_PATH = "C:/Users/Aniket/Downloads/EMI Collect Data.xlsx";
const ID_PREFIX = "EMI-SAMPLE-";
const TODAY = new Date();

// ---- helpers ---------------------------------------------------------------
const EXCEL_EPOCH = Date.UTC(1899, 11, 30); // Excel serial day 0
function parseDate(v) {
  if (v == null) return null;
  if (typeof v === "number" && isFinite(v) && v > 30000 && v < 60000) {
    return new Date(EXCEL_EPOCH + Math.round(v) * 86400000);
  }
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const d = +m[1], mo = +m[2], y = +m[3];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(Date.UTC(y, mo - 1, d));
    }
  }
  return null;
}
function parseAmount(v, emi) {
  if (typeof v === "number" && isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s.includes("dealer paid")) return emi;     // paid on borrower's behalf
    if (s.includes("pending") || s === "") return null;
    const n = parseFloat(s.replace(/[^0-9.]/g, ""));
    return isFinite(n) && n > 0 ? n : null;
  }
  return null;
}
function addMonths(d, n) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const ty = y + Math.floor(m / 12), tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(d.getUTCDate(), last)));
}
function dayDiff(a, b) {
  const am = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const bm = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.floor((bm - am) / 86400000);
}
const ds = (d) => d.toISOString().slice(0, 10);
const clean = (s, n) => (s == null ? null : String(s).trim().slice(0, n) || null);

// ---- connect ---------------------------------------------------------------
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const host = (process.env.DATABASE_URL || "").replace(/.*@/, "").split(/[:/]/)[0];

// Resolve the iTarang Finance tenant + a valid uploader user.
const tenant = (await c.query(
  `SELECT id, display_name FROM nbfc_tenants
   WHERE display_name ILIKE '%itarang%finance%' OR slug ILIKE '%itarang%'
   ORDER BY active_loans DESC NULLS LAST LIMIT 1`)).rows[0];
if (!tenant) { console.error("No iTarang Finance tenant found — aborting."); await c.end(); process.exit(1); }
const uploader = (await c.query(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`)).rows[0];
const uploaderId = uploader?.id ?? "66ed9c18-e048-4f77-93f5-d85f06cdcbd1";
console.log(`DB: ${host}\nTenant: ${tenant.display_name} (${tenant.id})\nUploader: ${uploaderId}\n`);

// ---- idempotent cleanup of prior sample rows -------------------------------
await c.query("BEGIN");
await c.query(`DELETE FROM emi_payment_attempts WHERE loan_sanction_id LIKE $1`, [ID_PREFIX + "%"]);
await c.query(`DELETE FROM emi_schedules WHERE loan_sanction_id LIKE $1`, [ID_PREFIX + "%"]);
await c.query(`DELETE FROM nbfc_loans WHERE loan_application_id LIKE $1`, [ID_PREFIX + "%"]);
await c.query(`DELETE FROM loan_sanctions WHERE id LIKE $1`, [ID_PREFIX + "%"]);
await c.query(`DELETE FROM leads WHERE id LIKE $1`, [ID_PREFIX + "%"]);

if (CLEAN_ONLY) {
  await c.query("COMMIT");
  console.log("Cleaned all EMI-SAMPLE- rows. Done.");
  await c.end();
  process.exit(0);
}

// ---- read sheet ------------------------------------------------------------
const wb = xlsx.readFile(XLSX_PATH);
const rows = xlsx.utils.sheet_to_json(wb.Sheets["EMI Data"], { defval: null });
const INST_KEYS = [
  ["1st Amount Collected", "EMI Collect Date"],
  ["2nd Amount Collected", "EMI Collect Date_1"],
  ["3rd Amount Collected", "EMI Collect Date_2"],
  ["4th Amount Collected", "EMI Collect Date_3"],
  ["5th  Amount Collected", "EMI Collect Date_4"],
  ["6th Amount Collected", "EMI Collect Date_5"],
  ["7th Amount Collected", "EMI Collect Date_6"],
];

let loans = 0, schedules = 0, paid = 0, overdue = 0, scheduled = 0, skipped = 0;

for (let idx = 0; idx < rows.length; idx++) {
  const r = rows[idx];
  const driver = clean(r["Driver Name"], 200);
  const emi = Number(r["Total EMI Amount"]) || 0;
  const tenure = Number(r["Tenure"]) || 0;
  const loanAmt = Number(r["Total Loan Amount"]) || 0;
  const install = parseDate(r["Battery Installation Date"]);
  if (!driver || !emi || !tenure || !install) { skipped++; continue; }

  const n = String(idx + 1).padStart(2, "0");
  const leadId = `${ID_PREFIX}LEAD-${n}`;
  const loanId = `${ID_PREFIX}LOAN-${n}`;
  const [city, state] = String(r["Location"] ?? "").split(",").map((s) => s.trim());

  // lead
  await c.query(
    `INSERT INTO leads (id, full_name, owner_name, phone, mobile, current_address, city, state,
        lead_source, lead_status, status, payment_method, loan_required, uploader_id)
     VALUES ($1,$2,$2,$3,$3,$4,$5,$6,'emi_sample_import','converted','disbursed','finance',true,$7)`,
    [leadId, driver, clean(r["Driver Mobile No"], 20), clean(r["Driver Address"], 500),
     clean(city, 100), clean(state, 100), uploaderId],
  );

  // loan_sanction
  await c.query(
    `INSERT INTO loan_sanctions (id, lead_id, loan_amount, emi, tenure_months, nbfc_id, status, disbursed_at, sanctioned_at)
     VALUES ($1,$2,$3,$4,$5,$6,'disbursed',$7,$7)`,
    [loanId, leadId, loanAmt, emi, tenure, tenant.id, install.toISOString()],
  );

  // installments — resolve paid history
  const insts = INST_KEYS.map(([ak, dk]) => ({
    amount: parseAmount(r[ak], emi),
    date: parseDate(r[dk]),
  }));

  let paidSum = 0, maxDpd = 0;
  const scheduleRows = [];
  for (let i = 1; i <= tenure; i++) {
    const due = addMonths(install, i);
    const hist = i <= insts.length ? insts[i - 1] : null;
    if (hist && hist.amount != null) {
      const paidAt = hist.date ?? due;
      const od = Math.max(0, dayDiff(due, paidAt));
      const status = od > 0 ? "paid_late" : "paid";
      paidSum += hist.amount;
      paid++;
      scheduleRows.push([loanId, ds(due), status, od, i, hist.amount, paidAt.toISOString(), "CASH-IMPORT", "cash"]);
    } else {
      const od = dayDiff(due, TODAY);
      let status = "scheduled", days = 0;
      if (od > 0) { status = od > 90 ? "missed" : "overdue"; days = Math.min(720, od); maxDpd = Math.max(maxDpd, days); overdue++; }
      else scheduled++;
      scheduleRows.push([loanId, ds(due), status, days, i, emi, null, null, null]);
    }
    schedules++;
  }

  for (const sr of scheduleRows) {
    await c.query(
      `INSERT INTO emi_schedules (loan_sanction_id, due_date, status, days_overdue, emi_seq, amount, paid_at, payment_ref, collection_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, sr);
  }

  const outstanding = Math.max(0, loanAmt - paidSum);
  await c.query(
    `INSERT INTO nbfc_loans (loan_application_id, tenant_id, vehicleno, emi_amount, emi_due_date_dom, current_dpd, outstanding_amount, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
    [loanId, tenant.id, clean(r["Battery No"], 64), emi, install.getUTCDate(), maxDpd, outstanding],
  );
  loans++;
}

// refresh tenant cached active-loan count
await c.query(
  `UPDATE nbfc_tenants SET active_loans = (SELECT count(*) FROM nbfc_loans WHERE tenant_id=$1 AND is_active=true), updated_at=now() WHERE id=$1`,
  [tenant.id]);

await c.query("COMMIT");
console.log(`Seeded ${loans} loans, ${schedules} installments (paid ${paid}, overdue/missed ${overdue}, scheduled ${scheduled}). Skipped ${skipped} rows.`);
console.log(`\n==> Reload /nbfc/emi-tracker on ${host}.`);
await c.end();
