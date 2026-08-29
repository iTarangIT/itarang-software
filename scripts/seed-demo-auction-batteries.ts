/**
 * Seed a demo battery fleet into an NBFC tenant, ready to be driven through
 * the recovery → auction flow by hand.
 *
 * Follows the same path as scripts/import-emi-collect-data.ts, because that is
 * the path the portal actually reads:
 *
 *   lead → loan_sanctions(status=disbursed, nbfc_id)
 *     → projectDisbursedLoan()   [builds nbfc_loans + emi_schedules]
 *     → set nbfc_loans.vehicleno = battery serial
 *     → overlay a part-paid / part-defaulted collection history
 *
 * A battery appears on /nbfc/batteries iff an `nbfc_loans` row exists with the
 * tenant id, `is_active = true` and a non-null `vehicleno`. Everything else on
 * that screen (customer, dealer, CDS, PCI, DPD) is enrichment resolved through
 * loan_sanctions → leads → dealers and emi_schedules.
 *
 * The fleet is a spread, not five copies of one story: two hard defaults
 * (DPD ~90 / ~60), one early default (~30), two current and paying (DPD 0).
 * That way the Lead Intelligence tiles, the CDS bands, the DPD buckets and the
 * EMI-status filter all have something to show. Every loan is left with
 * `recovery_flagged_at` NULL, so "Flag for Recovery" on /nbfc/leads accepts
 * the defaulted ones — that action requires a live loan_sanctions row whose
 * nbfc_id matches the caller's tenant and which has not been flagged before.
 *
 * SOH / FRESHNESS / ALERTS stay "—"/"Never": those come from the IoT VPS keyed
 * on the serial, and these demo serials have no telemetry. The rest of the
 * flow does not depend on them.
 *
 * Idempotent: deterministic ids (LS-DEMO-<PREFIX>-n / LEAD-DEMO-<PREFIX>-n)
 * plus conflict guards, so re-running never duplicates. The EMI overlay is
 * recomputed from today on every run, so DPD stays current.
 *
 * TENANT-AGNOSTIC. It first shipped hardcoded to iTarang Finance; the same
 * walkthrough is now needed on other tenants (ELECTRO FINANCE LMT on sandbox,
 * 2026-08-18), and the two databases do not even share dealer accounts, so
 * the tenant, dealer and uploader are all arguments:
 *
 *   --tenant <slug>        nbfc_tenants.slug (default: the iTarang Finance id below)
 *   --dealer <accounts.id> the dealer every demo lead is booked under. MUST
 *                          exist on the target DB — leads.dealer_id FKs to it.
 *   --uploader <users.id>  leads.uploader_id (NOT NULL). Default: the tenant's
 *                          first nbfc_admin member, else its first member.
 *   --prefix <TOKEN>       serial + id prefix, e.g. EF → DEMO-BAT-EF-0001,
 *                          LS-DEMO-EF-1. Default AUC (the original ids).
 *   --flag                 also flag the DEFAULTED batteries (DPD > 0) for
 *                          recovery, as the /nbfc/leads action would. Opt-in:
 *                          the current, paying batteries are never flagged.
 *   --evaluate             record a measured state of health for every fleet
 *                          battery that is already in the recovery pipeline
 *                          (flagged by hand or by --flag). This is what
 *                          unlocks "→ Refurbishable" / "→ Ready for auction"
 *                          on the recovery board: the buttons and the server
 *                          both gate on the latest evaluation's SOH, and no
 *                          IoT telemetry exists for demo serials. Writes the
 *                          evaluation row DIRECTLY — same price and grade
 *                          maths as the wizard (computeBasePrice/gradeForSoh)
 *                          — but does NOT move the card: the wizard's
 *                          recordEvaluation() would auto-advance the stage,
 *                          and the point of a demo is that the operator
 *                          presses the buttons. Batteries not yet in the
 *                          pipeline are listed, not evaluated: an evaluation
 *                          hangs off a pipeline row and there is nowhere else
 *                          in the app that reads a measured SOH.
 *   --count <N>            fleet size (default 5). The five hand-written
 *                          batteries below are always slots 1..5 and never
 *                          change; slots 6..N are generated from them —
 *                          same five stories, different borrower, city, ticket
 *                          size and default depth — so a bigger fleet still
 *                          spreads across every CDS band, DPD bucket and SOH
 *                          band instead of repeating one row. Deterministic
 *                          in the slot number, so growing the fleet later
 *                          leaves every existing serial untouched.
 *   --dry                  print the plan, write nothing.
 *
 * Usage:
 *   node --import tsx --env-file=.env.local scripts/seed-demo-auction-batteries.ts --dry
 *   node --import tsx --env-file=.env.local scripts/seed-demo-auction-batteries.ts \
 *        --tenant nbfc-kgdtlth5 --dealer ACC-ITARANG-20260427-b79e09 --prefix EF
 *   node --import tsx --env-file=.env.local scripts/seed-demo-auction-batteries.ts  *        --tenant nbfc-kgdtlth5 --dealer ACC-ITARANG-20260427-b79e09 --prefix EF --count 50
 */
import "./_load-env";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  emiSchedules,
  leads,
  loanSanctions,
  nbfcBatteryEvaluations,
  nbfcLoans,
  nbfcRecoveryPipeline,
  nbfcTenants,
  nbfcUsers,
  recoveryBatteries,
  users,
} from "@/lib/db/schema";
import { projectDisbursedLoan } from "@/lib/nbfc/servicing/projectDisbursedLoan";
import { flagLoanForRecovery } from "@/lib/nbfc/recovery/flag";
import { computeBasePrice } from "@/lib/nbfc/recovery/evaluation";
import {
  gradeForSoh,
  SOH_REFURBISHABLE_MIN,
  SOH_SCRAP_BELOW,
} from "@/lib/nbfc/recovery/stages";

// ── Arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY = argv.includes("--dry");
const FLAG = argv.includes("--flag");
const EVALUATE = argv.includes("--evaluate");

// The original hardcoded target, kept as the default so the documented
// no-argument invocation still seeds iTarang Finance exactly as before.
const DEFAULT_TENANT_ID = "02bda647-c164-4e81-809b-01cfe159cdb6"; // iTarang Finance
const DEFAULT_UPLOADER_ID = "66ed9c18-e048-4f77-93f5-d85f06cdcbd1";
const DEFAULT_DEALER_ID = "ACC-ITARANG-DEALER";

const TENANT_SLUG = arg("tenant");
const DEALER_ID = arg("dealer") ?? DEFAULT_DEALER_ID;
const PREFIX = (arg("prefix") ?? "AUC").toUpperCase();
const UPLOADER_ARG = arg("uploader");
const COUNT = (() => {
  const raw = arg("count");
  if (raw === undefined) return 5;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--count must be a positive integer, got '${raw}'.`);
  return n;
})();

/** Resolved in main() — tenant row + the uploader id. */
let TENANT_ID = DEFAULT_TENANT_ID;
let TENANT_NAME = "iTarang Finance";
let UPLOADER_ID = DEFAULT_UPLOADER_ID;

/** Midnight UTC today — the reference point for elapsed / overdue installments. */
const TODAY = (() => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
})();

// ── Demo fleet ───────────────────────────────────────────────────────────────
interface DemoBattery {
  key: number;
  serial: string;
  driverName: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  loanAmount: number;
  emiAmount: number;
  tenure: number;
  /** Months back from today the loan was disbursed. */
  disbursedMonthsAgo: number;
  /**
   * Extra days back, on top of the months. Whole-month disbursement dates put
   * every due date on today's day-of-month, so the newest overdue installment
   * is always ~31 days old and the portal's "1-30 days" DPD bucket can never
   * have anything in it. Shifting the schedule `d` days earlier makes the
   * newest overdue installment exactly `d` days late. Defaults to 0, which is
   * what the five hand-written batteries have always used.
   */
  disbursedDaysAgo?: number;
  /** Installments 1..paidCount were collected; the rest are overdue. */
  paidCount: number;
  /** Of the paid ones, these 1-based indices were collected late. */
  paidLate: number[];
  remarks: string;
  /**
   * Measured state of health for --evaluate, chosen so the fleet exercises
   * every band in stages.ts: >=70 refurbishable, 55-69 partial-working
   * (auction only), <55 scrap only.
   */
  soh: number;
  /** Battery pack manufacture date for --evaluate (drives age_months). */
  manufactured: string;
}

/** Serial for slot n: DEMO-BAT-0001 for the legacy AUC prefix (unchanged
 *  ids for the fleet already seeded on iTarang Finance), DEMO-BAT-EF-0001
 *  otherwise. */
const serialFor = (n: number) =>
  PREFIX === "AUC"
    ? `DEMO-BAT-${String(n).padStart(4, "0")}`
    : `DEMO-BAT-${PREFIX}-${String(n).padStart(4, "0")}`;

const BASE_FLEET: DemoBattery[] = [
  {
    key: 1,
    serial: serialFor(1),
    driverName: "Ramesh Yadav",
    phone: "9876500001",
    address: "12, Govind Nagar, Kanpur",
    city: "Kanpur",
    state: "Uttar Pradesh",
    loanAmount: 63000,
    emiAmount: 5250,
    tenure: 15,
    disbursedMonthsAgo: 12,
    paidCount: 8, // → installment 9 fell due ~3 months ago
    paidLate: [6, 8],
    remarks: "Demo battery for the recovery & auction walkthrough. Hard default.",
    soh: 78,
    manufactured: "2024-06-15",
  },
  {
    key: 2,
    serial: serialFor(2),
    driverName: "Sunita Devi",
    phone: "9876500002",
    address: "45, Aliganj, Lucknow",
    city: "Lucknow",
    state: "Uttar Pradesh",
    loanAmount: 55000,
    emiAmount: 5500,
    tenure: 12,
    disbursedMonthsAgo: 9,
    paidCount: 6, // → installment 7 fell due ~2 months ago
    paidLate: [5],
    remarks: "Demo battery for the recovery & auction walkthrough. Early default.",
    soh: 63,
    manufactured: "2024-09-01",
  },
  {
    key: 3,
    serial: serialFor(3),
    driverName: "Mohd. Irfan",
    phone: "9876500003",
    address: "8, Chowk Bazaar, Varanasi",
    city: "Varanasi",
    state: "Uttar Pradesh",
    loanAmount: 72000,
    emiAmount: 4800,
    tenure: 18,
    disbursedMonthsAgo: 7,
    paidCount: 5, // → installment 6 fell due ~1 month ago
    paidLate: [3],
    remarks: "Demo battery for the recovery & auction walkthrough. Fresh default, one EMI missed.",
    soh: 48,
    manufactured: "2024-11-20",
  },
  {
    key: 4,
    serial: serialFor(4),
    driverName: "Pooja Sharma",
    phone: "9876500004",
    address: "22, Civil Lines, Prayagraj",
    city: "Prayagraj",
    state: "Uttar Pradesh",
    loanAmount: 60000,
    emiAmount: 5000,
    tenure: 12,
    disbursedMonthsAgo: 5,
    paidCount: 5, // every elapsed installment paid → DPD 0
    paidLate: [2],
    remarks: "Demo battery for the recovery & auction walkthrough. Current, one late payment on record.",
    soh: 84,
    manufactured: "2025-02-10",
  },
  {
    key: 5,
    serial: serialFor(5),
    driverName: "Arvind Kumar",
    phone: "9876500005",
    address: "3, Rajendra Nagar, Patna",
    city: "Patna",
    state: "Bihar",
    loanAmount: 48000,
    emiAmount: 4000,
    tenure: 12,
    disbursedMonthsAgo: 3,
    paidCount: 3, // every elapsed installment paid → DPD 0
    paidLate: [],
    remarks: "Demo battery for the recovery & auction walkthrough. Current, clean history.",
    soh: 76,
    manufactured: "2025-04-05",
  },
];

// ── Grown fleet ──────────────────────────────────────────────────────────────
// Slots 6..COUNT are generated from the five stories above rather than written
// out: a demo needs volume (paging, filters, DPD buckets with more than one row
// in them) but volume made of copies teaches nothing. Each generated slot keeps
// its archetype's SHAPE — hard default / early default / fresh default /
// current-with-a-blemish / current-and-clean — and varies the borrower, place,
// ticket size, tenure and how deep the default runs.
//
// Everything is derived from the slot number alone. No randomness: growing the
// fleet from 5 to 50 to 200 later must leave every serial already seeded, and
// every DPD it was demoed with, exactly where it was.

// Disjoint from the five hand-written borrowers, so a generated slot never
// collides with slot 1-5's name. Surnames are the gender-neutral ones only
// ("Devi"/"Kumar" are not) — the two pools are combined mechanically.
const FIRST_NAMES = [
  "Kavita", "Deepak", "Rekha", "Manoj", "Anita", "Sanjay",
  "Meena", "Vikas", "Sarita", "Rahul", "Nisha", "Alok",
];
const LAST_NAMES = [
  "Yadav", "Verma", "Sharma", "Singh", "Gupta", "Prasad",
  "Mishra", "Pandey", "Chauhan", "Saini", "Tiwari", "Rawat",
];
const PLACES = [
  { area: "Govind Nagar", city: "Kanpur", state: "Uttar Pradesh" },
  { area: "Aliganj", city: "Lucknow", state: "Uttar Pradesh" },
  { area: "Chowk Bazaar", city: "Varanasi", state: "Uttar Pradesh" },
  { area: "Civil Lines", city: "Prayagraj", state: "Uttar Pradesh" },
  { area: "Rajendra Nagar", city: "Patna", state: "Bihar" },
  { area: "Kankarbagh", city: "Patna", state: "Bihar" },
  { area: "Sigra", city: "Varanasi", state: "Uttar Pradesh" },
  { area: "Hazratganj", city: "Lucknow", state: "Uttar Pradesh" },
  { area: "Lalpur", city: "Ranchi", state: "Jharkhand" },
  { area: "Bistupur", city: "Jamshedpur", state: "Jharkhand" },
  { area: "Sector 62", city: "Noida", state: "Uttar Pradesh" },
  { area: "Rajouri Garden", city: "New Delhi", state: "Delhi" },
  { area: "Shahdara", city: "New Delhi", state: "Delhi" },
  { area: "Model Town", city: "Ludhiana", state: "Punjab" },
  { area: "Sadar Bazaar", city: "Agra", state: "Uttar Pradesh" },
  { area: "Thatipur", city: "Gwalior", state: "Madhya Pradesh" },
];
const TENURES = [12, 15, 18, 24];
// Spans every band in stages.ts: >=70 refurbishable, 55-69 partial-working,
// <55 scrap — so an auction demo can always find a lot of each kind.
const SOH_POOL = [88, 82, 78, 74, 71, 68, 63, 58, 52, 45, 91, 66, 57, 49, 85];

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The disbursement date for a battery: months back, then days back. */
function disbursementDate(b: Pick<DemoBattery, "disbursedMonthsAgo" | "disbursedDaysAgo">): Date {
  const d = addMonthsClamped(TODAY, -b.disbursedMonthsAgo);
  if (b.disbursedDaysAgo) d.setUTCDate(d.getUTCDate() - b.disbursedDaysAgo);
  return d;
}

/** Installments fallen due by TODAY for a loan of this age and tenure. */
function elapsedFor(disbursedMonthsAgo: number, tenure: number, disbursedDaysAgo = 0): number {
  const disbursedAt = disbursementDate({ disbursedMonthsAgo, disbursedDaysAgo });
  let n = 0;
  for (let i = 1; i <= tenure; i++) {
    if (addMonthsClamped(disbursedAt, i).getTime() < TODAY.getTime()) n++;
  }
  return n;
}

function generateBattery(key: number): DemoBattery {
  const i = key - BASE_FLEET.length - 1; // 0-based index among generated slots
  const archetype = BASE_FLEET[(key - 1) % BASE_FLEET.length];
  const place = PLACES[i % PLACES.length];
  const driverName = `${FIRST_NAMES[i % FIRST_NAMES.length]} ${
    LAST_NAMES[((i % LAST_NAMES.length) + Math.floor(i / FIRST_NAMES.length) + 1) % LAST_NAMES.length]
  }`;

  const tenure = TENURES[(i * 3) % TENURES.length];
  const loanAmount =
    clamp(archetype.loanAmount + ((((i * 7) % 11) - 5) * 4000), 32000, 120000);
  const emiAmount = Math.max(1000, Math.round(loanAmount / tenure / 50) * 50);

  // Keep the loan live: disbursed at least 3 months ago, never so long ago that
  // the whole tenure has run off (a closed loan is not a battery to recover).
  const disbursedMonthsAgo = clamp(
    archetype.disbursedMonthsAgo + (((i * 5) % 5) - 2),
    3,
    tenure - 1,
  );
  // Spread the offsets across the month so the "1-30 days" bucket fills.
  const disbursedDaysAgo = (i * 9) % 30;
  const elapsed = elapsedFor(disbursedMonthsAgo, tenure, disbursedDaysAgo);

  // Archetypes 1-3 default, 4-5 are current. For a defaulter, missing 1..4
  // installments puts it in a DPD bucket ~30/60/90/120 days deep.
  const defaults = elapsedInstallments(archetype) > archetype.paidCount;
  // `i` alone, not `i + key`: key is i + BASE_FLEET.length, so `i + key` is
  // 2i + 5 and `% 4` can only land on two of the four values — the fleet came
  // out with DPD 31 and 92 and nothing in the 60 or 120 buckets.
  const missed = defaults ? 1 + (i % 4) : 0;
  const paidCount = clamp(elapsed - missed, 0, elapsed);

  const paidLate = (i % 3 === 0 ? [] : i % 3 === 1 ? [2] : [1, 3]).filter(
    (n) => n <= paidCount,
  );

  const manufacturedAt = addMonthsClamped(TODAY, -(14 + (i % 18)));

  return {
    key,
    serial: serialFor(key),
    driverName,
    phone: `98765${String(key).padStart(5, "0")}`,
    address: `${((i * 13) % 99) + 1}, ${place.area}, ${place.city}`,
    city: place.city,
    state: place.state,
    loanAmount,
    emiAmount,
    tenure,
    disbursedMonthsAgo,
    disbursedDaysAgo,
    paidCount,
    paidLate,
    remarks: `Demo battery for the recovery & auction walkthrough. ${
      defaults ? `Default, ${missed} EMI${missed === 1 ? "" : "s"} missed.` : "Current."
    }`,
    soh: SOH_POOL[i % SOH_POOL.length],
    manufactured: fmt(manufacturedAt),
  };
}

const FLEET: DemoBattery[] = [
  ...BASE_FLEET.slice(0, COUNT),
  ...Array.from({ length: Math.max(0, COUNT - BASE_FLEET.length) }, (_, n) =>
    generateBattery(BASE_FLEET.length + n + 1),
  ),
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Add `n` whole months, clamping the day to the target month's length. */
function addMonthsClamped(d: Date, n: number): Date {
  const month = d.getUTCMonth() + n;
  const targetYear = d.getUTCFullYear() + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDom = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(d.getUTCDate(), lastDom)));
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Seed one battery ─────────────────────────────────────────────────────────
async function seedBattery(b: DemoBattery) {
  const lsId = `LS-DEMO-${PREFIX}-${b.key}`;
  const leadId = `LEAD-DEMO-${PREFIX}-${b.key}`;
  const disbursedAt = disbursementDate(b);

  return db.transaction(async (tx) => {
    // 1. Lead — borrower context (name, city, dealer) for the portal columns.
    await tx
      .insert(leads)
      .values({
        id: leadId,
        dealer_id: DEALER_ID,
        full_name: b.driverName,
        owner_name: b.driverName,
        business_name: TENANT_NAME,
        phone: b.phone,
        mobile: b.phone,
        permanent_address: b.address,
        current_address: b.address,
        city: b.city,
        state: b.state,
        remarks: b.remarks,
        loan_required: true,
        payment_method: "finance",
        status: "converted",
        lead_status: "converted",
        lead_source: "demo_auction_seed",
        uploader_id: UPLOADER_ID,
      })
      .onConflictDoNothing({ target: leads.id });

    // Re-assert on a prior run (the insert above no-ops).
    await tx.update(leads).set({ dealer_id: DEALER_ID }).where(eq(leads.id, leadId));

    // 2. loan_sanctions — the origination record. `recovery_flagged_at` stays
    //    NULL so "Flag for Recovery" is still available on this loan.
    await tx
      .insert(loanSanctions)
      .values({
        id: lsId,
        lead_id: leadId,
        loan_amount: b.loanAmount.toString(),
        disbursement_amount: b.loanAmount.toString(),
        emi: b.emiAmount.toString(),
        tenure_months: b.tenure,
        loan_approved_by: TENANT_NAME,
        status: "disbursed",
        nbfc_id: TENANT_ID,
        sanctioned_at: disbursedAt,
        disbursed_at: disbursedAt,
      })
      .onConflictDoNothing({ target: loanSanctions.id });

    // Re-assert on a prior run. The insert above no-ops on conflict, so the
    // sanction stays frozen at whatever the FIRST run wrote — and since the
    // EMI schedule is generated from `disbursed_at` and `tenure_months`, any
    // later change to a battery's plan (a different tenure, ticket size or
    // disbursement date — which is exactly what growing the fleet re-derives)
    // would leave the stored schedule on the old dates while the overlay in
    // step 5 computed paid/overdue against the new ones. That mismatch is
    // silent: it just yields wrong DPDs.
    await tx
      .update(loanSanctions)
      .set({
        loan_amount: b.loanAmount.toString(),
        disbursement_amount: b.loanAmount.toString(),
        emi: b.emiAmount.toString(),
        tenure_months: b.tenure,
        status: "disbursed",
        nbfc_id: TENANT_ID,
        sanctioned_at: disbursedAt,
        disbursed_at: disbursedAt,
      })
      .where(eq(loanSanctions.id, lsId));

    // 3. Disbursement bridge → nbfc_loans + emi_schedules skeleton.
    //    The bridge only generates a schedule when the loan has none, so drop
    //    one that no longer matches the plan and let it rebuild.
    const stale = await tx
      .select({ id: emiSchedules.id, due_date: emiSchedules.due_date })
      .from(emiSchedules)
      .where(eq(emiSchedules.loan_sanction_id, lsId))
      .orderBy(asc(emiSchedules.due_date));
    const expectedFirstDue = fmt(addMonthsClamped(disbursedAt, 1));
    if (stale.length > 0 && (stale.length !== b.tenure || stale[0].due_date !== expectedFirstDue)) {
      await tx.delete(emiSchedules).where(eq(emiSchedules.loan_sanction_id, lsId));
    }
    await projectDisbursedLoan(tx, lsId);

    // 4. Battery serial onto the servicing ledger row — this is what makes the
    //    battery visible on /nbfc/batteries at all.
    await tx
      .update(nbfcLoans)
      .set({ vehicleno: b.serial, updated_at: new Date() })
      .where(eq(nbfcLoans.loan_application_id, lsId));

    // 5. Overlay a collection history: 1..paidCount collected, the rest of the
    //    elapsed installments overdue.
    const schedule = await tx
      .select()
      .from(emiSchedules)
      .where(eq(emiSchedules.loan_sanction_id, lsId))
      .orderBy(asc(emiSchedules.due_date));

    let collected = 0;
    let maxDpd = 0;

    for (let i = 0; i < schedule.length; i++) {
      const row = schedule[i];
      const seq = i + 1;
      const dueDate = new Date(`${row.due_date}T00:00:00Z`);
      const base = {
        emi_seq: seq,
        amount: b.emiAmount.toString(),
      };

      if (seq <= b.paidCount) {
        const late = b.paidLate.includes(seq);
        const paidAt = late ? addMonthsClamped(dueDate, 0) : dueDate;
        if (late) paidAt.setUTCDate(paidAt.getUTCDate() + 9);
        collected += b.emiAmount;
        await tx
          .update(emiSchedules)
          .set({
            ...base,
            status: late ? "paid_late" : "paid",
            paid_at: paidAt,
            days_overdue: late ? 9 : 0,
            amount_paid: b.emiAmount.toString(),
          })
          .where(eq(emiSchedules.id, row.id));
      } else if (dueDate.getTime() < TODAY.getTime()) {
        const dpd = daysBetween(TODAY, dueDate);
        maxDpd = Math.max(maxDpd, dpd);
        await tx
          .update(emiSchedules)
          .set({
            ...base,
            status: "overdue",
            paid_at: null,
            days_overdue: dpd,
            amount_paid: "0",
          })
          .where(eq(emiSchedules.id, row.id));
      } else {
        await tx
          .update(emiSchedules)
          .set({ ...base, status: "scheduled", paid_at: null, days_overdue: 0, amount_paid: "0" })
          .where(eq(emiSchedules.id, row.id));
      }
    }

    // 6. Recompute the ledger headline numbers.
    const outstanding = Math.max(0, b.loanAmount - collected);
    await tx
      .update(nbfcLoans)
      .set({
        outstanding_amount: outstanding.toString(),
        current_dpd: maxDpd,
        emi_amount: b.emiAmount.toString(),
        emi_due_date_dom: disbursedAt.getUTCDate(),
        is_active: true,
        updated_at: new Date(),
      })
      .where(eq(nbfcLoans.loan_application_id, lsId));

    return { lsId, leadId, disbursedAt, outstanding, maxDpd, installments: schedule.length };
  });
}

/** Installments that have fallen due by TODAY, given the disbursement date. */
function elapsedInstallments(b: DemoBattery): number {
  return elapsedFor(b.disbursedMonthsAgo, b.tenure, b.disbursedDaysAgo);
}

// ── --flag: put the defaulters into the recovery pipeline ────────────────────
async function flagDefaulters() {
  // Any elapsed, unpaid installment → the loan is in default.
  const defaulters = FLEET.filter((b) => elapsedInstallments(b) > b.paidCount);
  console.log(
    `\nFlagging ${defaulters.length} defaulted batter${defaulters.length === 1 ? "y" : "ies"} for recovery…`,
  );
  for (const b of defaulters) {
    const lsId = `LS-DEMO-${PREFIX}-${b.key}`;
    try {
      const r = await flagLoanForRecovery({
        tenant_id: TENANT_ID,
        loan_sanction_id: lsId,
        reason: `Demo seed — ${b.remarks}`,
        actor_user_id: UPLOADER_ID,
        battery_serial: b.serial,
        context: { entity_type: "loan", note: "seed-demo-auction-batteries --flag" },
      });
      console.log(`  ✓ ${b.serial} flagged (${r.status})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Already flagged is the idempotent path, not a failure.
      if (/already|CONFLICT/i.test(msg)) console.log(`  · ${b.serial} already flagged`);
      else console.error(`  ✗ ${b.serial}: ${msg}`);
    }
  }
}

// ── --evaluate: a measured SOH on every fleet battery in the pipeline ────────
async function evaluateInPipeline() {
  const serials = FLEET.map((b) => b.serial);
  const rows = await db
    .select({
      id: nbfcRecoveryPipeline.id,
      serial: nbfcRecoveryPipeline.battery_serial,
      stage: nbfcRecoveryPipeline.stage,
      battery_id: nbfcRecoveryPipeline.battery_id,
    })
    .from(nbfcRecoveryPipeline)
    .where(
      and(
        eq(nbfcRecoveryPipeline.tenant_id, TENANT_ID),
        inArray(nbfcRecoveryPipeline.battery_serial, serials),
      ),
    );
  const bySerial = new Map(rows.map((r) => [r.serial, r]));

  console.log(`\nRecording state of health…`);
  for (const b of FLEET) {
    const row = bySerial.get(b.serial);
    if (!row) {
      console.log(
        `  · ${b.serial}: not in the recovery pipeline — flag it (or pass --flag) and re-run`,
      );
      continue;
    }
    const [existing] = await db
      .select({ id: nbfcBatteryEvaluations.id })
      .from(nbfcBatteryEvaluations)
      .where(
        and(
          eq(nbfcBatteryEvaluations.recovery_pipeline_id, row.id),
          eq(nbfcBatteryEvaluations.tenant_id, TENANT_ID),
        ),
      )
      .limit(1);
    if (existing) {
      console.log(`  · ${b.serial}: evaluation already on file`);
      continue;
    }

    // Same maths the wizard runs (recordEvaluation), minus the stage move.
    // "scrap" as the workshop decision below the floor is what an honest
    // inspector would tick; above it there is always something to repair.
    const decision = b.soh < SOH_SCRAP_BELOW ? "scrap" : "minor_repair";
    const healthy = b.soh >= SOH_REFURBISHABLE_MIN;
    const salvageable = b.soh >= SOH_SCRAP_BELOW;
    const { base_auction_price, rejected } = computeBasePrice({
      soh: b.soh,
      decision,
      reject: false,
      original_value: b.loanAmount,
    });
    const grade = gradeForSoh(b.soh);

    await db.transaction(async (tx) => {
      await tx.insert(nbfcBatteryEvaluations).values({
        tenant_id: TENANT_ID,
        recovery_pipeline_id: row.id,
        step1: {
          soh_percent: b.soh,
          physical_condition: healthy ? "good" : salvageable ? "fair" : "poor",
          manufacturing_date: b.manufactured,
          iot_status: "offline",
          bms_health: healthy ? "healthy" : salvageable ? "degraded" : "failed",
          charger_type: "48V 10A",
        },
        step2: {
          decision,
          estimated_cost: healthy ? 1500 : salvageable ? 3500 : 0,
          checklist: {
            terminal_cleaning: true,
            software_recalibration: healthy,
            warranty_reset: false,
          },
        },
        step3: { original_value: b.loanAmount, reject: false },
        base_auction_price: base_auction_price.toFixed(2),
        rejected,
        condition_grade: grade === "scrap" ? null : grade,
      });
      // The grade the auction sells on lives on the battery master too.
      if (row.battery_id) {
        await tx
          .update(recoveryBatteries)
          .set({
            condition_grade: grade === "scrap" ? null : grade,
            updated_at: new Date(),
          })
          .where(eq(recoveryBatteries.id, row.battery_id));
      }
    });
    console.log(
      `  ✓ ${b.serial}: SOH ${b.soh}% → ${grade}` +
        (rejected ? " (rejected)" : `, base ₹${base_auction_price.toLocaleString("en-IN")}`) +
        `  [card stays in ${row.stage}]`,
    );
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const host = (process.env.DATABASE_URL || "").match(/@([^/:]+)/)?.[1];
  console.log(`DB host: ${host}`);

  // Resolve the tenant. By slug when given; the original iTarang Finance id
  // otherwise. Refuse rather than seed a fleet nobody can log in to see.
  if (TENANT_SLUG) {
    const [t] = await db
      .select({ id: nbfcTenants.id, name: nbfcTenants.display_name, active: nbfcTenants.is_active })
      .from(nbfcTenants)
      .where(eq(nbfcTenants.slug, TENANT_SLUG))
      .limit(1);
    if (!t) throw new Error(`No nbfc_tenants row with slug '${TENANT_SLUG}' on ${host}.`);
    if (!t.active) throw new Error(`Tenant '${TENANT_SLUG}' is not active on ${host}.`);
    TENANT_ID = t.id;
    TENANT_NAME = t.name;
  }

  // Resolve the uploader: an explicit id, else the tenant's first nbfc_admin,
  // else its first member. leads.uploader_id is NOT NULL and the value must
  // be a real users.id on THIS database — the default id belongs to iTarang
  // Finance and does not exist on the sandbox database at all.
  if (UPLOADER_ARG) {
    UPLOADER_ID = UPLOADER_ARG;
  } else if (TENANT_SLUG) {
    const members = await db
      .select({ user_id: nbfcUsers.user_id, role: nbfcUsers.role })
      .from(nbfcUsers)
      .innerJoin(users, eq(users.id, nbfcUsers.user_id))
      .where(eq(nbfcUsers.tenant_id, TENANT_ID));
    const pick = members.find((m) => m.role === "nbfc_admin") ?? members[0];
    if (!pick) throw new Error(`Tenant '${TENANT_SLUG}' has no nbfc_users member with a users row; pass --uploader.`);
    UPLOADER_ID = pick.user_id;
  }

  // The dealer must exist: leads.dealer_id FKs to accounts.id, and a missing
  // account fails the very first insert with a 23503 that names a constraint
  // rather than the actual problem.
  const [dealer] = await db
    .select({ id: accounts.id, name: accounts.business_entity_name })
    .from(accounts)
    .where(eq(accounts.id, DEALER_ID))
    .limit(1);
  if (!dealer) throw new Error(`Dealer account '${DEALER_ID}' does not exist on ${host}; pass --dealer <accounts.id>.`);

  console.log(`Tenant:   ${TENANT_ID} (${TENANT_NAME})`);
  console.log(`Dealer:   ${DEALER_ID} (${dealer.name})`);
  console.log(`Uploader: ${UPLOADER_ID}`);
  console.log(`Prefix:   ${PREFIX}`);
  console.log(`Count:    ${COUNT}`);
  console.log(`Today:    ${fmt(TODAY)}`);
  console.log(`Mode:     ${DRY ? "DRY-RUN (no writes)" : "APPLY"}\n`);

  const row = (b: DemoBattery) => ({
    serial: b.serial,
    sanction: `LS-DEMO-${PREFIX}-${b.key}`,
    driver: b.driverName,
    city: b.city,
    loan: b.loanAmount,
    emi: b.emiAmount,
    tenure: b.tenure,
    disbursed: fmt(disbursementDate(b)),
    paid: b.paidCount,
    soh: b.soh,
  });
  const TABLE_MAX = 12;
  if (FLEET.length <= TABLE_MAX) {
    console.table(FLEET.map(row));
  } else {
    // A 50-row table buries the thing you actually want to check — that the
    // fleet still spreads across the buckets the portal filters on.
    console.table(FLEET.slice(0, TABLE_MAX).map(row));
    console.log(`… and ${FLEET.length - TABLE_MAX} more (${serialFor(TABLE_MAX + 1)} … ${serialFor(FLEET.length)})`);
    const defaulted = FLEET.filter((b) => elapsedInstallments(b) > b.paidCount);
    const band = (n: number) => (n >= 70 ? "refurbishable ≥70" : n >= 55 ? "partial 55-69" : "scrap <55");
    const bands = FLEET.reduce<Record<string, number>>((acc, b) => {
      acc[band(b.soh)] = (acc[band(b.soh)] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `Spread:   ${FLEET.length} batteries — ${defaulted.length} in default, ` +
        `${FLEET.length - defaulted.length} current · SOH ` +
        Object.entries(bands).map(([k, v]) => `${v} ${k}`).join(", "),
    );
  }
  console.log(`Modes:    seed${FLAG ? " + flag" : ""}${EVALUATE ? " + evaluate" : ""}`);

  if (DRY) {
    console.log("\nDRY-RUN complete — no writes. Re-run without --dry to apply.");
    process.exit(0);
  }

  console.log("\nSeeding…");
  for (const b of FLEET) {
    try {
      const r = await seedBattery(b);
      console.log(
        `  ✓ ${b.serial} → ${r.lsId}  (${r.installments} EMIs, ${b.paidCount} paid, ` +
          `outstanding ₹${r.outstanding.toLocaleString("en-IN")}, DPD ${r.maxDpd})`,
      );
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string; detail?: string; constraint?: string } }).cause;
      const detail = cause
        ? `[${cause.code}] ${cause.message}${cause.detail ? ` — ${cause.detail}` : ""}${cause.constraint ? ` (${cause.constraint})` : ""}`
        : e instanceof Error
          ? e.message
          : String(e);
      console.error(`  ✗ ${b.serial}: ${detail}`);
    }
  }

  if (FLAG) await flagDefaulters();
  if (EVALUATE) await evaluateInPipeline();

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(nbfcLoans)
    .where(and(eq(nbfcLoans.tenant_id, TENANT_ID), eq(nbfcLoans.is_active, true)));

  console.log(`\nDone. Tenant active loans now: ${count}.`);
  console.log(
    `Search '${serialFor(1).slice(0, -5)}' on /nbfc/batteries, or find the drivers on /nbfc/leads to flag for recovery.`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
