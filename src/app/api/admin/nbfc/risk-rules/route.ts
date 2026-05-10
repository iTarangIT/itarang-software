/**
 * E-067 — Risk Rule Engine: list current threshold values.
 *
 * GET /api/admin/nbfc/risk-rules
 *
 * Returns one row per canonical rule_key (8 total) with the *current* tunable
 * value held in `nbfc_risk_rule_thresholds`. Admin-only. Read-only — never
 * mutates the table. The dual-approval gate (E-085) is the only writer.
 *
 * Self-heals from a missing seed: if the table is empty (e.g. fresh sandbox
 * where the migration ran but the seed step was skipped) the route lazily
 * inserts the eight rows from the canonical catalogue using the BRD defaults
 * before returning. This keeps the AC1 contract ("returns all 8") robust
 * against the seed-vs-migration ordering of `npm run db:push`.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { nbfcRiskRules } from "@/lib/db/schema";
import {
  resolveAdminActor,
  statusFromError,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";
import {
  RISK_RULE_KEYS,
  RISK_RULE_CATALOGUE,
  type RiskRuleKey,
} from "@/lib/nbfc/admin/riskRules";

function assertAdminRole(role: string) {
  if (!(ADMIN_ROLES as readonly string[]).includes(role)) {
    throw new Error("FORBIDDEN: not an admin");
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function seedIfEmpty() {
  const existing = await db.select({ rule_key: nbfcRiskRules.rule_key })
    .from(nbfcRiskRules);
  const have = new Set(existing.map((r) => r.rule_key));
  const missing = RISK_RULE_KEYS.filter((k) => !have.has(k));
  if (missing.length === 0) return;
  await db.insert(nbfcRiskRules).values(
    missing.map((k) => ({
      rule_key: k,
      rule_label: RISK_RULE_CATALOGUE[k].label,
      current_value: String(RISK_RULE_CATALOGUE[k].default_value),
      unit: RISK_RULE_CATALOGUE[k].unit,
    })),
  ).onConflictDoNothing({ target: nbfcRiskRules.rule_key });
}

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveAdminActor(req.headers);
    assertAdminRole(actor.role);
    await seedIfEmpty();

    const rows = await db
      .select({
        key: nbfcRiskRules.rule_key,
        label: nbfcRiskRules.rule_label,
        current_value: nbfcRiskRules.current_value,
        unit: nbfcRiskRules.unit,
      })
      .from(nbfcRiskRules);

    // Stable ordering by canonical enum order so the UI doesn't reshuffle
    // each request.
    const byKey = new Map(rows.map((r) => [r.key as RiskRuleKey, r]));
    const rules = RISK_RULE_KEYS
      .map((k) => {
        const r = byKey.get(k);
        if (!r) return null;
        return {
          key: k,
          label: r.label,
          current_value: Number(r.current_value),
          unit: r.unit ?? RISK_RULE_CATALOGUE[k].unit,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return NextResponse.json({ rules });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
