/**
 * The single reader of the governed risk thresholds.
 *
 * `nbfc_risk_rules` has had a seed (E-067), an admin UI, and a two-person
 * approval gate (E-068) since before the risk cards were written — and until
 * now nothing in the engine read it. Every evaluator hard-coded its own number,
 * so changing "Usage Drop Threshold" in the admin screen changed nothing at all.
 * A comment in hand-coded-cards.ts even pointed at a `risk-thresholds.ts` that
 * did not exist. This is that file.
 *
 * Values are resolved once per run and snapshotted into
 * `risk_card_runs.evidence_json.thresholds`, so a card from three months ago can
 * still be read against the thresholds it was actually judged by, not today's.
 */
import { db } from "@/lib/db";
import { nbfcRiskRules } from "@/lib/db/schema";
import {
  RISK_RULE_CATALOGUE,
  RISK_RULE_KEYS,
  isRiskRuleKey,
  type RiskRuleKey,
} from "@/lib/nbfc/admin/riskRules";

export type RiskThresholds = Record<RiskRuleKey, number>;

/** BRD defaults. Used when a rule row is missing or the DB is unreachable. */
export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = Object.fromEntries(
  RISK_RULE_KEYS.map((k) => [k, RISK_RULE_CATALOGUE[k].default_value]),
) as RiskThresholds;

/**
 * Resolve all eight thresholds. Never throws: a threshold we cannot read falls
 * back to its BRD default rather than failing the whole run, because a risk card
 * that does not render is worse than one judged by the documented default.
 */
export async function loadRiskThresholds(): Promise<RiskThresholds> {
  const resolved: RiskThresholds = { ...DEFAULT_RISK_THRESHOLDS };
  try {
    const rows = await db
      .select({ rule_key: nbfcRiskRules.rule_key, current_value: nbfcRiskRules.current_value })
      .from(nbfcRiskRules);
    for (const row of rows) {
      if (!isRiskRuleKey(row.rule_key)) continue; // unknown key — ignore, don't crash
      const v = Number(row.current_value);
      if (Number.isFinite(v)) resolved[row.rule_key] = v;
    }
  } catch (e) {
    console.warn("[risk-thresholds] could not read nbfc_risk_rules; using BRD defaults", e);
  }
  return resolved;
}
