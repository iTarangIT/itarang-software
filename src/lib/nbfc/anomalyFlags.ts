/**
 * E-066 — Auto Anomaly Flag evaluator (BRD §6.3.2)
 *
 * Reads per-NBFC comparison metrics derived from `nbfc_loans` (delinquency_pct,
 * avg_dpd, recovery_rate_pct) and writes/clears `nbfc_anomaly_flags` rows.
 *
 * Thresholds (configured for E-066 — set autonomously per --auto-approve-schema):
 *   - delinquency_pct > 15  -> breach
 *   - recovery_rate_pct < 70 -> breach
 *   - avg_dpd > 30          -> breach
 *   - 2 or 3 breaches => severity 'red'
 *   - exactly 1 breach => severity 'amber'
 *   - 0 breaches => no flag (clear any existing open flag)
 *
 * Idempotent semantics:
 *   - For a given NBFC there is at most one OPEN flag row (cleared_at IS NULL)
 *     at any time. The evaluator enforces this by inserting a new open row
 *     only when none exists; if severity or reasons drift, the existing open
 *     row is updated in place. When metrics recover, the open row is closed
 *     by stamping cleared_at = now().
 *
 * Notification side-effect:
 *   - The evaluator returns a `flagged` array. Newly-set red/amber flags are
 *     identified by `was_new=true`; the route layer feeds these to the Ops
 *     notification surface (audit-logged via console.info today; pluggable
 *     transport later — keeping the function pure for testability).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  nbfcAnomalyFlags,
  nbfcLoans,
  nbfcTenants,
} from "@/lib/db/schema";

export const ANOMALY_THRESHOLDS = {
  delinquency_pct_gt: 15,
  recovery_rate_pct_lt: 70,
  avg_dpd_gt: 30,
} as const;

export type AnomalySeverity = "red" | "amber";

export type EvaluatedFlag = {
  nbfc_id: string;
  severity: AnomalySeverity;
  reasons: string[];
  was_new: boolean;
};

export type AnomalyEvaluationResult = {
  evaluated_count: number;
  flagged: EvaluatedFlag[];
  cleared: string[]; // nbfc_ids whose open flag was cleared
};

type TenantRollup = {
  nbfc_id: string;
  total_loans: number;
  delinquent_loans: number;
  performing_loans: number;
  sum_dpd: number;
  delinquency_pct: number;
  recovery_rate_pct: number;
  avg_dpd: number;
};

function toNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute per-NBFC delinquency/recovery/avg_dpd from `nbfc_loans` for every
 * active tenant. Tenants with zero loans get all-zero metrics, which never
 * trigger a breach (recovery_rate_pct=0 would naively breach <70 — but we
 * skip zero-loan tenants explicitly to avoid a false-flag on a brand-new
 * NBFC that hasn't booked any loans yet).
 */
async function loadTenantRollups(
  filterNbfcId?: string,
): Promise<TenantRollup[]> {
  const tenantsQ = db
    .select({
      id: nbfcTenants.id,
    })
    .from(nbfcTenants)
    .where(eq(nbfcTenants.is_active, true));

  const tenants = filterNbfcId
    ? (await tenantsQ).filter((t) => t.id === filterNbfcId)
    : await tenantsQ;

  if (tenants.length === 0) return [];

  const rollups = await db
    .select({
      tenant_id: nbfcLoans.tenant_id,
      total: sql<string>`count(*)`,
      delinquent: sql<string>`count(*) filter (where coalesce(${nbfcLoans.current_dpd}, 0) > 0)`,
      performing: sql<string>`count(*) filter (where coalesce(${nbfcLoans.current_dpd}, 0) = 0)`,
      sum_dpd: sql<string>`coalesce(sum(coalesce(${nbfcLoans.current_dpd}, 0)), 0)`,
    })
    .from(nbfcLoans)
    .groupBy(nbfcLoans.tenant_id);

  const byTenant = new Map<string, (typeof rollups)[number]>();
  for (const r of rollups) byTenant.set(r.tenant_id, r);

  return tenants.map((t) => {
    const r = byTenant.get(t.id);
    const total = toNum(r?.total ?? 0);
    const delinquent = toNum(r?.delinquent ?? 0);
    const performing = toNum(r?.performing ?? 0);
    const sumDpd = toNum(r?.sum_dpd ?? 0);
    const delinquency_pct =
      total > 0 ? Number(((delinquent / total) * 100).toFixed(2)) : 0;
    const recovery_rate_pct =
      total > 0 ? Number(((performing / total) * 100).toFixed(2)) : 0;
    const avg_dpd = total > 0 ? Number((sumDpd / total).toFixed(2)) : 0;
    return {
      nbfc_id: t.id,
      total_loans: total,
      delinquent_loans: delinquent,
      performing_loans: performing,
      sum_dpd: sumDpd,
      delinquency_pct,
      recovery_rate_pct,
      avg_dpd,
    };
  });
}

function classify(rollup: TenantRollup): {
  severity: AnomalySeverity | null;
  reasons: string[];
} {
  // Zero-loan tenants are never flagged (no signal to act on).
  if (rollup.total_loans <= 0) return { severity: null, reasons: [] };

  const reasons: string[] = [];
  if (rollup.delinquency_pct > ANOMALY_THRESHOLDS.delinquency_pct_gt) {
    reasons.push(
      `delinquency_pct=${rollup.delinquency_pct} > ${ANOMALY_THRESHOLDS.delinquency_pct_gt}`,
    );
  }
  if (rollup.recovery_rate_pct < ANOMALY_THRESHOLDS.recovery_rate_pct_lt) {
    reasons.push(
      `recovery_rate_pct=${rollup.recovery_rate_pct} < ${ANOMALY_THRESHOLDS.recovery_rate_pct_lt}`,
    );
  }
  if (rollup.avg_dpd > ANOMALY_THRESHOLDS.avg_dpd_gt) {
    reasons.push(
      `avg_dpd=${rollup.avg_dpd} > ${ANOMALY_THRESHOLDS.avg_dpd_gt}`,
    );
  }

  if (reasons.length >= 2) return { severity: "red", reasons };
  if (reasons.length === 1) return { severity: "amber", reasons };
  return { severity: null, reasons: [] };
}

/**
 * Read the currently OPEN flag row for an NBFC (cleared_at IS NULL).
 * If multiple open rows exist (shouldn't, by invariant) the most recent
 * by flagged_at wins.
 */
async function readOpenFlag(nbfcId: string) {
  const rows = await db
    .select({
      id: nbfcAnomalyFlags.id,
      severity: nbfcAnomalyFlags.severity,
      reasons: nbfcAnomalyFlags.reasons,
    })
    .from(nbfcAnomalyFlags)
    .where(
      and(
        eq(nbfcAnomalyFlags.nbfc_id, nbfcId),
        isNull(nbfcAnomalyFlags.cleared_at),
      ),
    )
    .orderBy(sql`${nbfcAnomalyFlags.flagged_at} desc`)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Evaluate anomaly flags across all active NBFCs (or one, if `nbfcId` given).
 * Pure-ish — writes to `nbfc_anomaly_flags`, returns the post-evaluation
 * snapshot of newly-set + still-open flags plus the list of cleared ids.
 */
export async function evaluateAnomalyFlags(
  nbfcId?: string,
): Promise<AnomalyEvaluationResult> {
  const rollups = await loadTenantRollups(nbfcId);

  const flagged: EvaluatedFlag[] = [];
  const cleared: string[] = [];

  for (const rollup of rollups) {
    const { severity, reasons } = classify(rollup);
    const existing = await readOpenFlag(rollup.nbfc_id);

    if (severity == null) {
      // No breach — clear any existing open flag.
      if (existing) {
        await db
          .update(nbfcAnomalyFlags)
          .set({ cleared_at: new Date() })
          .where(eq(nbfcAnomalyFlags.id, existing.id));
        cleared.push(rollup.nbfc_id);
      }
      continue;
    }

    if (existing) {
      // Update in place if severity or reasons drifted; otherwise no-op.
      const sameSeverity = existing.severity === severity;
      const existingReasons = Array.isArray(existing.reasons)
        ? (existing.reasons as string[])
        : [];
      const sameReasons =
        existingReasons.length === reasons.length &&
        existingReasons.every((r, i) => r === reasons[i]);
      if (!sameSeverity || !sameReasons) {
        await db
          .update(nbfcAnomalyFlags)
          .set({ severity, reasons })
          .where(eq(nbfcAnomalyFlags.id, existing.id));
      }
      flagged.push({
        nbfc_id: rollup.nbfc_id,
        severity,
        reasons,
        was_new: false,
      });
    } else {
      await db.insert(nbfcAnomalyFlags).values({
        nbfc_id: rollup.nbfc_id,
        severity,
        reasons,
      });
      flagged.push({
        nbfc_id: rollup.nbfc_id,
        severity,
        reasons,
        was_new: true,
      });
      // BRD: notify iTarang Ops on newly-set flag. Console.info is the
      // append-only audit transport for now (server logs are durable);
      // pluggable transport (email/slack) can subscribe later.
      console.info(
        `[E-066] anomaly flag set nbfc_id=${rollup.nbfc_id} severity=${severity} reasons=${JSON.stringify(reasons)}`,
      );
    }
  }

  return {
    evaluated_count: rollups.length,
    flagged,
    cleared,
  };
}
