/**
 * Import "EMI Collect Data.xlsx" into the iTarang Finance NBFC tenant.
 *
 * Reads the `EMI Data` sheet, normalises the (messy) real-world data, and for
 * each valid row creates a disbursed loan in the NBFC servicing ledger so it
 * shows up in Portfolio Overview / Battery Monitoring / Recovery:
 *
 *   dealer (upsert by code) → lead → loan_sanctions(status=disbursed, nbfc_id)
 *     → projectDisbursedLoan()  [reused: builds nbfc_loans + emi_schedules]
 *     → overlay actual EMI collection history (paid / paid_late / overdue)
 *
 * Idempotent: deterministic LS-IMPORT-/LEAD-IMPORT-/DLR-IMPORT- ids + conflict
 * guards, so re-running never duplicates.
 *
 * Usage:
 *   tsx scripts/import-emi-collect-data.ts --dry   # parse + print, no writes
 *   tsx scripts/import-emi-collect-data.ts         # apply
 */
import "./_load-env";
import path from "node:path";
import xlsx from "xlsx";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  dealers,
  leads,
  loanSanctions,
  emiSchedules,
  nbfcLoans,
} from "@/lib/db/schema";
import { projectDisbursedLoan } from "@/lib/nbfc/servicing/projectDisbursedLoan";

// ── Constants ────────────────────────────────────────────────────────────────
const XLSX_PATH = "C:/Users/Aniket/Downloads/EMI Collect Data.xlsx";
const SHEET = "EMI Data";
const TENANT_ID = "02bda647-c164-4e81-809b-01cfe159cdb6"; // iTarang Finance
const UPLOADER_ID = "66ed9c18-e048-4f77-93f5-d85f06cdcbd1"; // nbfc user (leads.uploader_id NOT NULL)
const TODAY = new Date(Date.UTC(2026, 5, 17)); // 2026-06-17 (currentDate); avoids Date.now()
const DRY = process.argv.includes("--dry");

// All imported leads share one dealer so the portal's Dealer column reads
// "iTarang Dealer". leads.dealer_id FKs to accounts.id, and the battery page
// resolves the display name via dealers.dealer_id (= same code) → company_name.
const DEALER_ID = "ACC-ITARANG-DEALER";
const DEALER_NAME = "iTarang Dealer";

// ── Normalisation helpers ────────────────────────────────────────────────────

/** Excel serial → JS Date (Excel epoch = 1899-12-30 UTC). */
function serialToDate(n: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000);
}

/** Parse a date cell: Excel serial number OR dd/mm/yyyy(-ish) string. Returns null if unparseable/invalid. */
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
  // Reject impossible dates (e.g. 30/2/2026) by round-tripping.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}

const PAID_BY_DEALER = /dealer\s*(paid|collected)/i;

/**
 * Parse a "Amount Collected" cell into a paid signal.
 *  - numeric / "6300/Dealer Collected" → { paid:true, amount:<n> }
 *  - "Dealer paid" / "Dealer Collected" (no number) → { paid:true, amount:null } (pay at EMI amount)
 *  - "Pending" / "#VALUE!" / blank → { paid:false }
 */
function parseCollected(v: unknown): { paid: boolean; amount: number | null } {
  if (v == null || v === "") return { paid: false, amount: null };
  if (typeof v === "number") return Number.isFinite(v) ? { paid: true, amount: v } : { paid: false, amount: null };
  const s = String(v).trim();
  const num = s.match(/(\d[\d,]*\.?\d*)/);
  const amount = num ? Number(num[1].replace(/,/g, "")) : null;
  if (amount != null && amount > 0) return { paid: true, amount };
  if (PAID_BY_DEALER.test(s)) return { paid: true, amount: null };
  return { paid: false, amount: null };
}

/** First 10-15 digit phone number in a cell that may hold two. */
function firstPhone(v: unknown): string | null {
  if (v == null) return null;
  const m = String(v).match(/\d{6,15}/);
  return m ? m[0] : null;
}

/** "Aligharh, Uttar Pradesh" → { city, state }. */
function splitLocation(v: unknown): { city: string | null; state: string | null } {
  if (v == null) return { city: null, state: null };
  const parts = String(v).split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { city: null, state: null };
  if (parts.length === 1) return { city: parts[0], state: null };
  return { city: parts[0], state: parts.slice(1).join(", ") };
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Row model ────────────────────────────────────────────────────────────────
type Raw = Record<string, unknown>;

interface Mapped {
  rowIndex: number; // 1-based among valid rows (drives deterministic ids)
  dealerName: string;
  dealerPhone: string | null;
  driverName: string;
  driverPhone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  financer: string | null;
  remarks: string | null;
  batteryNo: string | null;
  loanAmount: number | null;
  emiAmount: number | null;
  tenure: number;
  startDate: Date; // installation date (disbursed_at proxy)
  // Positional: index i = i-th installment. null = not collected (preserves gaps).
  collected: ({ amount: number | null; date: Date | null } | null)[];
  pendingNote: string | null;
  warnings: string[];
}

const COLLECT_COLS: [string, string][] = [
  ["1st Amount Collected", "EMI Collect Date"],
  ["2nd Amount Collected", "EMI Collect Date_1"],
  ["3rd Amount Collected", "EMI Collect Date_2"],
  ["4th Amount Collected", "EMI Collect Date_3"],
  ["5th  Amount Collected", "EMI Collect Date_4"],
  ["6th Amount Collected", "EMI Collect Date_5"],
  ["7th Amount Collected", "EMI Collect Date_6"],
];

function mapRow(r: Raw, rowIndex: number): Mapped | null {
  const driverName = (r["Driver Name"] ?? "").toString().trim();
  const loanAmount = num(r["Total Loan Amount"]);
  // Skip junk rows (8–10): no borrower and no loan amount.
  if (!driverName && loanAmount == null) return null;

  const warnings: string[] = [];
  const emiAmount = num(r["Total EMI Amount"]);
  const tenure = num(r["Tenure"]) ?? 0;
  const startDate = parseDate(r["Battery Installation Date"]);
  if (!startDate) {
    warnings.push(`unparseable Battery Installation Date "${r["Battery Installation Date"]}" — using today`);
  }
  const { city, state } = splitLocation(r["Location"]);

  const collected = COLLECT_COLS.map(([amtCol, dateCol]) => {
    const c = parseCollected(r[amtCol]);
    if (!c.paid) return null; // keep the slot null → preserves mid-schedule gaps
    const amount = c.amount ?? emiAmount; // "Dealer paid" → pay at EMI amount
    return { amount, date: parseDate(r[dateCol]) };
  });

  const remarksBits = [
    r["Remarks"] ? `Remarks: ${r["Remarks"]}` : null,
    r["Charger No"] ? `Charger No: ${r["Charger No"]}` : null,
    // keep the second phone if present
    /\D*\d{6,}\D+\d{6,}/.test(String(r["Driver Mobile No"] ?? ""))
      ? `Phones: ${r["Driver Mobile No"]}`
      : null,
  ].filter(Boolean);

  return {
    rowIndex,
    dealerName: (r["Dealer Name"] ?? "Unknown Dealer").toString().trim() || "Unknown Dealer",
    dealerPhone: firstPhone(r["Delar Mobile No"]),
    driverName: driverName || "Unknown",
    driverPhone: firstPhone(r["Driver Mobile No"]),
    address: r["Driver Address"] ? String(r["Driver Address"]).trim() : null,
    city,
    state,
    financer: r["Financer"] ? String(r["Financer"]).trim() : null,
    remarks: remarksBits.length ? remarksBits.join(" | ") : null,
    batteryNo: r["Battery No"] ? String(r["Battery No"]).trim() : null,
    loanAmount,
    emiAmount,
    tenure,
    startDate: startDate ?? TODAY,
    collected,
    pendingNote: r["Pending Amount"] != null ? String(r["Pending Amount"]) : null,
    warnings,
  };
}

// One shared dealer for every imported lead. accounts.id satisfies the
// leads.dealer_id FK; the dealers row (same code) supplies the display name.
async function ensureDealer() {
  await db
    .insert(accounts)
    .values({
      id: DEALER_ID,
      business_entity_name: DEALER_NAME,
      gstin: "NA-ITARANG-DLR",
      dealer_code: DEALER_ID,
      status: "active",
      onboarding_status: "active",
    })
    .onConflictDoNothing({ target: accounts.id });
  await db
    .insert(dealers)
    .values({
      dealer_id: DEALER_ID,
      company_name: DEALER_NAME,
      company_type: "proprietorship",
      finance_enabled: true,
      onboarding_status: "active",
    })
    .onConflictDoNothing({ target: dealers.dealer_id });
}

// ── Per-row import ───────────────────────────────────────────────────────────
async function importRow(m: Mapped) {
  const lsId = `LS-IMPORT-${m.rowIndex}`;
  const leadId = `LEAD-IMPORT-${m.rowIndex}`;

  await db.transaction(async (tx) => {
    // 1. Lead (borrower context: name + city). dealer_id points at the shared
    //    "iTarang Dealer" account; the original sheet dealer name is kept in
    //    business_name for reference.
    await tx
      .insert(leads)
      .values({
        id: leadId,
        dealer_id: DEALER_ID,
        full_name: m.driverName,
        owner_name: m.driverName,
        business_name: m.dealerName,
        phone: m.driverPhone,
        mobile: m.driverPhone,
        permanent_address: m.address,
        current_address: m.address,
        city: m.city,
        state: m.state,
        remarks: m.remarks,
        loan_required: true,
        payment_method: "finance",
        status: "converted",
        lead_status: "converted",
        lead_source: "nbfc_import",
        uploader_id: UPLOADER_ID,
      })
      .onConflictDoNothing({ target: leads.id });

    // Ensure dealer_id is set even on rows from a prior run (insert above no-ops).
    await tx.update(leads).set({ dealer_id: DEALER_ID }).where(eq(leads.id, leadId));

    // 3. loan_sanctions — disbursed + tenant-scoped (drives portfolio aggregates)
    await tx
      .insert(loanSanctions)
      .values({
        id: lsId,
        lead_id: leadId,
        loan_amount: m.loanAmount?.toString() ?? null,
        disbursement_amount: m.loanAmount?.toString() ?? null,
        emi: m.emiAmount?.toString() ?? null,
        tenure_months: m.tenure || null,
        loan_approved_by: "iTarang Finance",
        status: "disbursed",
        nbfc_id: TENANT_ID,
        sanctioned_at: m.startDate,
        disbursed_at: m.startDate,
      })
      .onConflictDoNothing({ target: loanSanctions.id });

    // 4. Reused bridge → nbfc_loans + emi_schedules skeleton + active_loans refresh
    await projectDisbursedLoan(tx, lsId);

    // 5a. Battery serial onto the servicing ledger row
    if (m.batteryNo) {
      await tx
        .update(nbfcLoans)
        .set({ vehicleno: m.batteryNo, updated_at: new Date() })
        .where(eq(nbfcLoans.loan_application_id, lsId));
    }

    // 5b. Overlay actual collection history onto the generated schedule.
    const schedule = await tx
      .select()
      .from(emiSchedules)
      .where(eq(emiSchedules.loan_sanction_id, lsId))
      .orderBy(asc(emiSchedules.due_date));

    let totalCollected = 0;
    let maxDpd = 0;

    for (let i = 0; i < schedule.length; i++) {
      const row = schedule[i];
      const dueDate = new Date(`${row.due_date}T00:00:00Z`);
      const paid = m.collected[i]; // i-th installment paid?

      if (paid) {
        const paidDate = paid.date ?? dueDate;
        const overdue = Math.max(
          0,
          Math.round((paidDate.getTime() - dueDate.getTime()) / 86_400_000),
        );
        totalCollected += paid.amount ?? m.emiAmount ?? 0;
        await tx
          .update(emiSchedules)
          .set({
            status: overdue > 0 ? "paid_late" : "paid",
            paid_at: paidDate,
            days_overdue: overdue,
          })
          .where(eq(emiSchedules.id, row.id));
      } else if (dueDate.getTime() < TODAY.getTime()) {
        // Past-due and not collected → overdue.
        const dpd = Math.round((TODAY.getTime() - dueDate.getTime()) / 86_400_000);
        maxDpd = Math.max(maxDpd, dpd);
        await tx
          .update(emiSchedules)
          .set({ status: "overdue", days_overdue: dpd })
          .where(eq(emiSchedules.id, row.id));
      }
      // else: future installment stays 'scheduled'
    }

    // 5c. Recompute outstanding + current DPD on the ledger row.
    const outstanding = Math.max(0, (m.loanAmount ?? 0) - totalCollected);
    await tx
      .update(nbfcLoans)
      .set({
        outstanding_amount: outstanding.toString(),
        current_dpd: maxDpd,
        updated_at: new Date(),
      })
      .where(eq(nbfcLoans.loan_application_id, lsId));

    return { lsId, leadId, paid: m.collected.length, outstanding, maxDpd };
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const host = (process.env.DATABASE_URL || "").match(/@([^/:]+)/)?.[1];
  console.log(`DB host: ${host}`);
  console.log(`Mode: ${DRY ? "DRY-RUN (no writes)" : "APPLY"}\n`);

  const wb = xlsx.readFile(path.normalize(XLSX_PATH));
  const raw = xlsx.utils.sheet_to_json<Raw>(wb.Sheets[SHEET], { defval: null });

  let idx = 0;
  const mapped: Mapped[] = [];
  for (const r of raw) {
    const m = mapRow(r, idx + 1);
    if (m) {
      idx++;
      m.rowIndex = idx;
      mapped.push(m);
    }
  }

  console.log(`Parsed ${mapped.length} valid loan row(s) (of ${raw.length}).\n`);
  console.table(
    mapped.map((m) => ({
      "#": m.rowIndex,
      dealer: m.dealerName,
      driver: m.driverName,
      financer: m.financer,
      loan: m.loanAmount,
      emi: m.emiAmount,
      tenure: m.tenure,
      start: fmt(m.startDate),
      paid: m.collected.filter(Boolean).length,
      collected: m.collected.reduce((s, c) => s + (c ? (c.amount ?? m.emiAmount ?? 0) : 0), 0),
      battery: m.batteryNo,
    })),
  );

  const withWarn = mapped.filter((m) => m.warnings.length);
  if (withWarn.length) {
    console.log("\nWarnings:");
    for (const m of withWarn) console.log(`  row ${m.rowIndex} (${m.driverName}): ${m.warnings.join("; ")}`);
  }

  console.log(`\nDealer column → "${DEALER_NAME}" for all rows. Original sheet dealers kept on lead.business_name:`);
  for (const name of new Set(mapped.map((m) => m.dealerName))) console.log(`  ${name}`);

  if (DRY) {
    console.log("\nDRY-RUN complete — no writes. Re-run without --dry to apply.");
    process.exit(0);
  }

  console.log("\nImporting…");
  await ensureDealer();
  let ok = 0;
  for (const m of mapped) {
    try {
      await importRow(m);
      ok++;
      console.log(`  ✓ row ${m.rowIndex} ${m.driverName} → LS-IMPORT-${m.rowIndex}`);
    } catch (e) {
      const cause = (e as { cause?: { message?: string; detail?: string; constraint?: string; code?: string } }).cause;
      const detail = cause
        ? `[${cause.code}] ${cause.message}${cause.detail ? ` — ${cause.detail}` : ""}${cause.constraint ? ` (constraint: ${cause.constraint})` : ""}`
        : e instanceof Error
          ? e.message
          : String(e);
      console.error(`  ✗ row ${m.rowIndex} ${m.driverName}: ${detail}`);
    }
  }

  // Report tenant ledger state.
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(nbfcLoans)
    .where(and(eq(nbfcLoans.tenant_id, TENANT_ID), eq(nbfcLoans.is_active, true)));

  console.log(`\nDone. Imported ${ok}/${mapped.length}. Tenant active loans now: ${count}.`);
  console.log("Open /nbfc/portfolio and /nbfc/batteries as iTarang Finance to view.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
