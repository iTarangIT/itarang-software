/**
 * E-067 — Risk Rule Engine: impact preview before commit.
 *
 * POST /api/admin/nbfc/risk-rules/preview
 *   body: { rule_key: <one of 8 enum>, new_value: number }
 *
 * Returns:
 *   {
 *     affected_accounts: number,
 *     accounts_moving_to_higher_band: number
 *   }
 *
 * Rules:
 *   • Admin-only (otherwise 403).
 *   • 400 on validation failure (unknown rule_key, missing/non-numeric value).
 *   • Read-only — MUST NOT mutate `nbfc_risk_rule_thresholds`. The actual
 *     commit happens via the dual-approval gate (E-085).
 *
 * Impact calculation per rule_key (see BRD §6.3.3):
 *   - cds_low_medium / cds_medium_high / cds_high_very_high:
 *       Count borrower_risk_scores whose CDS band would change under the new
 *       set of thresholds. accounts_moving_to_higher_band = subset whose new
 *       band index > old band index. CDS "Higher band index" means the
 *       account moved from Low→Medium, Medium→High, or High→Very-High.
 *   - emi_overdue_days:
 *       Count nbfc_loans whose alert state flips. An account is "alerted"
 *       iff current_dpd > threshold. Accounts moving to higher band =
 *       accounts that BECOME alerted (i.e. were not alerted before, are now).
 *   - pci_concern:
 *       Count borrower_risk_scores where pci_score < threshold flips.
 *       Higher band = accounts that newly fall below the new threshold
 *       (now flagged for monitoring).
 *   - usage_drop_pct / geo_shift_km / offline_alert_hours:
 *       These thresholds drive per-battery telemetry alerts, but the platform
 *       does not yet maintain a borrower-level rolling-average / GPS-centroid
 *       cache, so impact is not computable from the current schema. Return
 *       zeros — explicitly documented behaviour, not silent failure.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, sql, gt, lt, lte, gte, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  nbfcRiskRules,
  borrowerRiskScores,
  nbfcLoans,
} from "@/lib/db/schema";
import {
  resolveAdminActor,
  statusFromError,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";
import { RISK_RULE_KEYS, type RiskRuleKey } from "@/lib/nbfc/admin/riskRules";

function assertAdminRole(role: string) {
  if (!(ADMIN_ROLES as readonly string[]).includes(role)) {
    throw new Error("FORBIDDEN: not an admin");
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    rule_key: z.enum(RISK_RULE_KEYS),
    new_value: z.number().finite(),
  })
  .strict();

type PreviewCounts = {
  affected_accounts: number;
  accounts_moving_to_higher_band: number;
};

/** Map a CDS score to a band index 0..3 given the three thresholds. */
function cdsBandIndex(score: number, t: { lm: number; mh: number; hvh: number }): number {
  if (score < t.lm) return 0; // Low
  if (score < t.mh) return 1; // Medium
  if (score < t.hvh) return 2; // High
  return 3; // Very High
}

async function loadCurrentThresholds(): Promise<Record<RiskRuleKey, number>> {
  const rows = await db
    .select({
      rule_key: nbfcRiskRules.rule_key,
      current_value: nbfcRiskRules.current_value,
    })
    .from(nbfcRiskRules);
  const out = {} as Record<RiskRuleKey, number>;
  for (const r of rows) {
    out[r.rule_key as RiskRuleKey] = Number(r.current_value);
  }
  return out;
}

async function previewCdsChange(
  ruleKey: "cds_low_medium" | "cds_medium_high" | "cds_high_very_high",
  newValue: number,
  current: Record<RiskRuleKey, number>,
): Promise<PreviewCounts> {
  const oldT = {
    lm: current.cds_low_medium,
    mh: current.cds_medium_high,
    hvh: current.cds_high_very_high,
  };
  const newT = { ...oldT };
  if (ruleKey === "cds_low_medium") newT.lm = newValue;
  if (ruleKey === "cds_medium_high") newT.mh = newValue;
  if (ruleKey === "cds_high_very_high") newT.hvh = newValue;

  // Pull all CDS-scored borrowers. The risk page already aggregates this set,
  // and the cardinality here is borrower_risk_scores rows — bounded by the
  // platform's borrower count (tens of thousands at peak). For the impact
  // preview we just need accurate counts, not a stream — small in-memory
  // bucketing keeps the SQL trivial and guarantees identical band logic to
  // anywhere else in the codebase that wants to render a CDS band.
  const scored = await db
    .select({ cds: borrowerRiskScores.cds_score })
    .from(borrowerRiskScores)
    .where(isNotNull(borrowerRiskScores.cds_score));

  let affected = 0;
  let higher = 0;
  for (const row of scored) {
    if (row.cds === null) continue;
    const s = Number(row.cds);
    if (!Number.isFinite(s)) continue;
    const oldB = cdsBandIndex(s, oldT);
    const newB = cdsBandIndex(s, newT);
    if (oldB !== newB) {
      affected += 1;
      if (newB > oldB) higher += 1;
    }
  }
  return { affected_accounts: affected, accounts_moving_to_higher_band: higher };
}

async function previewEmiOverdueChange(
  newValue: number,
  current: Record<RiskRuleKey, number>,
): Promise<PreviewCounts> {
  const oldThr = current.emi_overdue_days;
  // Affected = accounts where alert state flips (alerted iff current_dpd > thr).
  // Higher band = accounts that BECOME alerted (more aggressive alerting).
  if (oldThr === newValue) {
    return { affected_accounts: 0, accounts_moving_to_higher_band: 0 };
  }

  const lo = Math.min(oldThr, newValue);
  const hi = Math.max(oldThr, newValue);
  // Loans whose current_dpd is in (lo, hi] flip state.
  const flipped = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(nbfcLoans)
    .where(and(gt(nbfcLoans.current_dpd, lo), lte(nbfcLoans.current_dpd, hi)));
  const flippedCount = Number(flipped[0]?.count ?? 0);

  if (newValue < oldThr) {
    // Lowering threshold → flipped loans become NEWLY alerted (move to higher).
    return {
      affected_accounts: flippedCount,
      accounts_moving_to_higher_band: flippedCount,
    };
  }
  // Raising threshold → flipped loans become NEWLY un-alerted (move to lower).
  return {
    affected_accounts: flippedCount,
    accounts_moving_to_higher_band: 0,
  };
}

async function previewPciConcernChange(
  newValue: number,
  current: Record<RiskRuleKey, number>,
): Promise<PreviewCounts> {
  const oldThr = current.pci_concern;
  if (oldThr === newValue) {
    return { affected_accounts: 0, accounts_moving_to_higher_band: 0 };
  }
  const lo = Math.min(oldThr, newValue);
  const hi = Math.max(oldThr, newValue);
  // PCI accounts with score in [lo, hi) flip flagged-state.
  const flipped = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(borrowerRiskScores)
    .where(
      and(
        isNotNull(borrowerRiskScores.pci_score),
        gte(borrowerRiskScores.pci_score, String(lo)),
        lt(borrowerRiskScores.pci_score, String(hi)),
      ),
    );
  const flippedCount = Number(flipped[0]?.count ?? 0);

  if (newValue > oldThr) {
    // Raising the concern threshold → newly flagged accounts (more flagged).
    return {
      affected_accounts: flippedCount,
      accounts_moving_to_higher_band: flippedCount,
    };
  }
  return {
    affected_accounts: flippedCount,
    accounts_moving_to_higher_band: 0,
  };
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveAdminActor(req.headers);
    assertAdminRole(actor.role);

    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: body must be JSON" },
        { status: 400 },
      );
    }
    const parsed = Body.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: "BAD_REQUEST: validation failed",
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const { rule_key, new_value } = parsed.data;
    const current = await loadCurrentThresholds();

    let counts: PreviewCounts;
    if (
      rule_key === "cds_low_medium" ||
      rule_key === "cds_medium_high" ||
      rule_key === "cds_high_very_high"
    ) {
      counts = await previewCdsChange(rule_key, new_value, current);
    } else if (rule_key === "emi_overdue_days") {
      counts = await previewEmiOverdueChange(new_value, current);
    } else if (rule_key === "pci_concern") {
      counts = await previewPciConcernChange(new_value, current);
    } else {
      // usage_drop_pct / geo_shift_km / offline_alert_hours — telemetry
      // aggregates not yet schema-backed at borrower level. Return zeros.
      counts = { affected_accounts: 0, accounts_moving_to_higher_band: 0 };
    }

    return NextResponse.json(counts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
