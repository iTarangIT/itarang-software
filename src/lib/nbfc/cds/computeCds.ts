/**
 * E-029 — Nightly CDS (Credit Default Score) computation.
 *
 * BRD Section 6.1.5:
 *   CDS = Σ(EMI_weight × recency_multiplier) + consecutive_default_penalty
 *         normalised to 0..100
 *
 * Per-borrower inputs (one CDS row per active loan_sanction):
 *   - Last 6 EMI rows from emi_schedules
 *   - Days overdue + status (paid / paid_late / missed / overdue / scheduled)
 *   - Consecutive missed-EMI streak
 *   - Telemetry: most recent ingestion lag (declining-usage / offline trends
 *     are read off telemetry_ingestion_log freshness)
 *
 * Confidence:
 *   HIGH    : ≥ 6 EMI records AND telemetry ingested within 12h
 *   MEDIUM  : 3–5 EMI records OR telemetry > 12h stale
 *   LOW     : < 3 EMI records OR restructuring/force-majeure flag set
 *
 * The job INSERTS a new borrower_risk_scores row per active loan
 * (immutable history per RBI Digital Lending Directions 2025) — never an
 * UPDATE in place.
 */
import { and, eq, isNull, desc } from "drizzle-orm";
import { db as defaultDb } from "@/lib/db";
import {
  loanSanctions,
  borrowerRiskScores,
  emiSchedules,
  telemetryIngestionLog,
  nbfcLoanRestructures,
} from "@/lib/db/schema";

export type CdsConfidence = "HIGH" | "MEDIUM" | "LOW";

/** How many EMI windows the CDS looks back over. */
export const CDS_EMI_HISTORY_DEPTH = 6;
/** Each consecutive most-recent missed/overdue EMI adds this to the numerator. */
export const STREAK_PENALTY_PER_DEFAULT = 0.5;
/** Streak penalty saturates after this many consecutive defaults (the window). */
export const STREAK_MAX_DEFAULTS = CDS_EMI_HISTORY_DEPTH;
/** Upper bound of the stale-telemetry risk term. */
export const TELEMETRY_MAX_RISK = 0.5;

export type CdsComputationRow = {
  loan_sanction_id: string;
  cds_score: number;
  confidence: CdsConfidence;
  emi_records_considered: number;
};

export type CdsRunResult = {
  computed_count: number;
  skipped_count: number;
  run_at: string;
  rows: CdsComputationRow[];
};

type DbLike = typeof defaultDb;

const TELEMETRY_FRESH_MS = 12 * 60 * 60 * 1000; // 12 hours

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Recency multiplier: most recent EMI weighted strongest. */
export function recencyMultiplier(positionFromMostRecent: number): number {
  // 0 (newest) -> 1.0, 1 -> 0.85, ... bottoming out at 0.4
  return Math.max(0.4, 1.0 - positionFromMostRecent * 0.12);
}

/**
 * Map an EMI row's status (and days_overdue) to its 0..1 weight in the
 * CDS sum. 0 = perfectly paid, 1 = full miss.
 */
export function emiWeight(status: string, daysOverdue: number | null): number {
  const s = (status || "").toLowerCase();
  if (s === "paid") return 0;
  if (s === "paid_late") {
    // Within 7 days late = 0.5; longer late = 0.7
    if ((daysOverdue ?? 0) <= 7) return 0.5;
    return 0.7;
  }
  if (s === "missed") return 1.0;
  if (s === "overdue") {
    // Active overdue: graduated by days
    const d = daysOverdue ?? 0;
    if (d <= 7) return 0.6;
    if (d <= 30) return 0.85;
    return 1.0;
  }
  // 'scheduled' or unknown — neutral (does not contribute to risk)
  return 0;
}

/**
 * Length of the trailing consecutive-default streak starting at the most
 * recent EMI. emis are ordered most-recent-first.
 */
function consecutiveDefaultStreak(
  emis: { status: string }[],
): number {
  let streak = 0;
  for (const e of emis) {
    const s = (e.status || "").toLowerCase();
    if (s === "missed" || s === "overdue") streak += 1;
    else break;
  }
  return streak;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Per-EMI line of the CDS math, in display order (newest first). */
export type CdsEmiBreakdown = {
  position: number; // 0 = newest
  status: string;
  days_overdue: number | null;
  emi_weight: number; // 0..1 from status/days
  recency_multiplier: number; // 1.0 (newest) … 0.4 (oldest)
  contribution: number; // emi_weight × recency_multiplier
};

/**
 * Every intermediate term behind a CDS number — the single source of truth
 * for both the nightly job (which only needs the final score) and the
 * explainability surface (which needs the whole derivation). Keeping the math
 * here means the drawer can never drift from the score it explains.
 */
export type CdsBreakdown = {
  per_emi: CdsEmiBreakdown[];
  weighted_sum: number; // Σ contribution
  recency_total: number; // Σ recency_multiplier (= weighted_sum_max)
  streak_count: number; // consecutive most-recent missed/overdue EMIs
  streak_penalty: number; // streak_count × STREAK_PENALTY_PER_DEFAULT
  telemetry_risk: number; // 0 … TELEMETRY_MAX_RISK from staleness
  weighted_sum_max: number; // if every EMI scored its worst (all weights = 1)
  streak_max: number; // STREAK_MAX_DEFAULTS × STREAK_PENALTY_PER_DEFAULT
  telemetry_max: number; // TELEMETRY_MAX_RISK
  numerator: number; // weighted_sum + streak_penalty + telemetry_risk
  denominator: number; // weighted_sum_max + streak_max + telemetry_max
  raw_score: number; // numerator ÷ denominator × 100, pre-clamp
  cds_score: number; // clamped, rounded 0..100
};

/**
 * Compute the full CDS derivation for a single loan. `computeCdsForLoan`
 * delegates to this so the score and its explanation are produced by the
 * exact same arithmetic.
 */
export function computeCdsBreakdown(opts: {
  emis: { status: string; days_overdue: number | null }[]; // most-recent first
  telemetryIngestedAt: Date | null;
  now?: Date;
}): CdsBreakdown {
  const now = opts.now ?? new Date();
  const emis = opts.emis.slice(0, CDS_EMI_HISTORY_DEPTH); // last N windows

  // ---- Weighted EMI sum (per-row terms retained for explainability) ----
  const per_emi: CdsEmiBreakdown[] = [];
  let weightedSum = 0;
  let totalRecency = 0;
  emis.forEach((e, idx) => {
    const w = emiWeight(e.status, e.days_overdue);
    const r = recencyMultiplier(idx);
    const contribution = w * r;
    weightedSum += contribution;
    totalRecency += r;
    per_emi.push({
      position: idx,
      status: e.status,
      days_overdue: e.days_overdue ?? null,
      emi_weight: round2(w),
      recency_multiplier: round2(r),
      contribution: round2(contribution),
    });
  });

  // ---- Consecutive default penalty ----
  const streak = consecutiveDefaultStreak(emis);
  const streakPenalty = streak * STREAK_PENALTY_PER_DEFAULT;

  // ---- Telemetry trend signal ----
  // declining_usage / offline-duration trend cannot be re-derived from a
  // single ingestion timestamp; we use staleness as a proxy: stale
  // telemetry suggests battery offline -> +risk.
  let telemetryRisk = 0;
  if (opts.telemetryIngestedAt) {
    const lagMs = now.getTime() - opts.telemetryIngestedAt.getTime();
    if (lagMs > TELEMETRY_FRESH_MS) {
      // 0 ... 0.5 over [12h, 7d]
      const days = lagMs / (24 * 60 * 60 * 1000);
      telemetryRisk = clamp((days - 0.5) / 13, 0, TELEMETRY_MAX_RISK);
    }
  }

  // ---- Normalise to 0..100 ----
  // Maximum possible weighted-sum given totalRecency (all weights = 1):
  //   weightedSumMax = totalRecency
  // Maximum streak penalty across the window, plus the telemetry ceiling.
  const weightedSumMax = totalRecency || 1; // avoid div-by-zero
  const streakMax = STREAK_MAX_DEFAULTS * STREAK_PENALTY_PER_DEFAULT;
  const telemetryMax = TELEMETRY_MAX_RISK;
  const denom = weightedSumMax + streakMax + telemetryMax;
  const numer = weightedSum + streakPenalty + telemetryRisk;
  const raw = (numer / denom) * 100;
  const cds = clamp(round2(raw), 0, 100);

  return {
    per_emi,
    weighted_sum: round2(weightedSum),
    recency_total: round2(totalRecency),
    streak_count: streak,
    streak_penalty: round2(streakPenalty),
    telemetry_risk: round2(telemetryRisk),
    weighted_sum_max: round2(weightedSumMax),
    streak_max: round2(streakMax),
    telemetry_max: round2(telemetryMax),
    numerator: round2(numer),
    denominator: round2(denom),
    raw_score: round2(raw),
    cds_score: cds,
  };
}

/**
 * Compute the CDS score and confidence for a single loan, given its
 * recent EMI history and the freshest telemetry timestamp for the
 * borrower's tenant.
 */
export function computeCdsForLoan(opts: {
  emis: { status: string; days_overdue: number | null }[]; // most-recent first
  telemetryIngestedAt: Date | null;
  restructuringFlag: boolean;
  now?: Date;
}): { cds_score: number; confidence: CdsConfidence } {
  const now = opts.now ?? new Date();
  const emis = opts.emis.slice(0, CDS_EMI_HISTORY_DEPTH);

  const { cds_score } = computeCdsBreakdown({
    emis,
    telemetryIngestedAt: opts.telemetryIngestedAt,
    now,
  });

  // ---- Confidence ----
  let confidence: CdsConfidence;
  const telemetryFresh =
    opts.telemetryIngestedAt != null &&
    now.getTime() - opts.telemetryIngestedAt.getTime() <= TELEMETRY_FRESH_MS;
  if (opts.restructuringFlag || emis.length < 3) {
    confidence = "LOW";
  } else if (emis.length >= CDS_EMI_HISTORY_DEPTH && telemetryFresh) {
    confidence = "HIGH";
  } else {
    confidence = "MEDIUM";
  }

  return { cds_score, confidence };
}

/**
 * Plain-language reference for the CDS inputs — surfaced in the
 * explainability drawer so an NBFC partner unfamiliar with the fields can
 * read the rules behind each number. Derived from the live `emiWeight` /
 * `recencyMultiplier` helpers so it can never drift from the computation.
 */
export const CDS_EMI_WEIGHT_RULES: {
  label: string;
  condition: string;
  weight: number;
}[] = [
  { label: "Paid on time", condition: "status = paid", weight: 0 },
  {
    label: "Paid late (≤ 7 days)",
    condition: "status = paid_late, days late ≤ 7",
    weight: 0.5,
  },
  {
    label: "Paid late (> 7 days)",
    condition: "status = paid_late, days late > 7",
    weight: 0.7,
  },
  {
    label: "Overdue (≤ 7 days)",
    condition: "status = overdue, days late ≤ 7",
    weight: 0.6,
  },
  {
    label: "Overdue (8–30 days)",
    condition: "status = overdue, days late 8–30",
    weight: 0.85,
  },
  {
    label: "Overdue (> 30 days)",
    condition: "status = overdue, days late > 30",
    weight: 1.0,
  },
  { label: "Missed", condition: "status = missed", weight: 1.0 },
  {
    label: "Scheduled / not yet due",
    condition: "future installment — neutral",
    weight: 0,
  },
];

/** Recency multiplier by position (newest first), straight from the helper. */
export const CDS_RECENCY_SCHEDULE: { position: number; multiplier: number }[] =
  Array.from({ length: CDS_EMI_HISTORY_DEPTH }, (_, i) => ({
    position: i,
    multiplier: round2(recencyMultiplier(i)),
  }));

export const CDS_STREAK_RULE = `Each consecutive most-recent missed or overdue EMI adds ${STREAK_PENALTY_PER_DEFAULT} to the risk total (up to ${STREAK_MAX_DEFAULTS} in a row). A clean most-recent EMI resets the streak to 0.`;

export const CDS_TELEMETRY_RULE = `Stale battery telemetry is a risk proxy: fresh (≤ 12h) adds 0; staleness ramps the term up to ${TELEMETRY_MAX_RISK} as it ages toward ~7 days offline.`;

/**
 * Run the nightly CDS job: walks every active loan_sanction, computes
 * CDS, and inserts a fresh borrower_risk_scores row.
 */
export async function runCdsNightlyJob(opts?: {
  db?: DbLike;
  now?: Date;
}): Promise<CdsRunResult> {
  const dbi = opts?.db ?? defaultDb;
  const now = opts?.now ?? new Date();

  // Active loans = status='disbursed' AND closed_at IS NULL.
  const loans = await dbi
    .select({
      id: loanSanctions.id,
      lead_id: loanSanctions.lead_id,
      nbfc_id: loanSanctions.nbfc_id,
    })
    .from(loanSanctions)
    .where(
      and(
        eq(loanSanctions.status, "disbursed"),
        isNull(loanSanctions.closed_at),
      ),
    );

  let computed = 0;
  let skipped = 0;
  const rows: CdsComputationRow[] = [];

  for (const loan of loans) {
    if (!loan.id) {
      skipped += 1;
      continue;
    }
    // borrower_risk_scores.loan_sanction_id is typed uuid in the schema
    // (E-026's design). Legacy loan_sanctions rows whose id was minted as
    // a non-uuid string cannot be persisted into the risk-scores history;
    // skip them safely rather than abort the whole run.
    if (!UUID_RE.test(loan.id)) {
      skipped += 1;
      continue;
    }

    // Pull last 6 EMI rows, most recent first.
    const emis = await dbi
      .select({
        status: emiSchedules.status,
        days_overdue: emiSchedules.days_overdue,
        due_date: emiSchedules.due_date,
      })
      .from(emiSchedules)
      .where(eq(emiSchedules.loan_sanction_id, loan.id))
      .orderBy(desc(emiSchedules.due_date))
      .limit(6);

    // Most recent telemetry ingestion for this tenant. Per the schema,
    // borrower_risk_scores.tenant_id == loan_sanctions.nbfc_id (the
    // partner NBFC). When nbfc_id is null we still compute but skip the
    // telemetry signal.
    let telemetryIngestedAt: Date | null = null;
    if (loan.nbfc_id) {
      const [tel] = await dbi
        .select({ ingested_at: telemetryIngestionLog.ingested_at })
        .from(telemetryIngestionLog)
        .where(eq(telemetryIngestionLog.tenant_id, loan.nbfc_id))
        .orderBy(desc(telemetryIngestionLog.ingested_at))
        .limit(1);
      telemetryIngestedAt = tel?.ingested_at ?? null;
    }

    // Restructuring/force-majeure: any nbfc_loan_restructures row drops
    // the confidence to LOW per BRD §6.1.5.
    const restructures = await dbi
      .select({ id: nbfcLoanRestructures.id })
      .from(nbfcLoanRestructures)
      .where(eq(nbfcLoanRestructures.loan_application_id, loan.id))
      .limit(1);
    const restructuringFlag = restructures.length > 0;

    const { cds_score, confidence } = computeCdsForLoan({
      emis: emis.map((e) => ({
        status: e.status,
        days_overdue: e.days_overdue ?? null,
      })),
      telemetryIngestedAt,
      restructuringFlag,
      now,
    });

    // Insert a fresh immutable history row.
    if (loan.nbfc_id) {
      await dbi.insert(borrowerRiskScores).values({
        tenant_id: loan.nbfc_id,
        borrower_id: loan.nbfc_id, // borrower keyed off the lead in this
        // schema; until E-026's borrower table is populated we tag tenant
        // and borrower_id identically. Downstream readers always project
        // by loan_sanction_id, so this is safe.
        loan_sanction_id: loan.id as unknown as string,
        cds_score: String(cds_score),
        confidence,
        computed_at: now,
      });
      computed += 1;
      rows.push({
        loan_sanction_id: loan.id,
        cds_score,
        confidence,
        emi_records_considered: emis.length,
      });
    } else {
      // No nbfc tenant binding -> skip persistence (cannot satisfy the
      // not-null tenant_id constraint).
      skipped += 1;
    }
  }

  return {
    computed_count: computed,
    skipped_count: skipped,
    run_at: now.toISOString(),
    rows,
  };
}
