/**
 * E-093 — Score Override service.
 *
 * NBFC Risk Manager can override a borrower's computed credit score with a
 * documented reason. The override is logged to audit_logs and is shown to
 * downstream decision flows as the "effective" score, but it does NOT mutate
 * the computed score (which lives in nbfc_score_runs / borrower_risk_scores
 * once E-092 lands; until then we just snapshot the value the caller passed).
 *
 * Append-only: creating a second override for the same
 * (loan_application_id, score_type) flips any prior is_active=true row to
 * is_active=false (superseded), and the new row becomes is_active=true.
 *
 * RBI Digital Lending Directions 2025: human override of credit scores must be
 * documented with reason and visible in audit log.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { and, desc, eq } from "drizzle-orm";
import { nbfcScoreOverrides, auditLogs } from "@/lib/db/schema";

export const RISK_MANAGER_ROLE = "nbfc_risk_manager";
export const SCORE_TYPES = ["cds", "pci"] as const;
export type ScoreType = (typeof SCORE_TYPES)[number];

export const MIN_REASON_LEN = 20;
export const MAX_REASON_LEN = 1000;

export interface CreateOverrideInput {
  tenant_id: string;
  loan_application_id: string;
  score_type: ScoreType;
  computed_score_value: number;
  override_value: number;
  reason: string;
  created_by: string;
}

export interface ScoreOverrideRow {
  id: string;
  loan_application_id: string;
  score_type: string;
  computed_score_value: string | number;
  override_value: string | number;
  reason: string;
  created_by: string;
  created_at: Date | string;
  is_active: boolean;
}

function toApi(row: ScoreOverrideRow) {
  return {
    id: row.id,
    loan_application_id: row.loan_application_id,
    score_type: row.score_type,
    computed_score_value: Number(row.computed_score_value),
    override_value: Number(row.override_value),
    reason: row.reason,
    created_by: row.created_by,
    created_at:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
    is_active: row.is_active,
  };
}

export async function createScoreOverride(input: CreateOverrideInput) {
  // Step 4 of YAML logic: mark any prior active row(s) for this pair as
  // is_active=false. We do this in a single UPDATE so we don't depend on a
  // single-row uniqueness constraint (history is allowed to have many).
  await db
    .update(nbfcScoreOverrides)
    .set({ is_active: false })
    .where(
      and(
        eq(nbfcScoreOverrides.loan_application_id, input.loan_application_id),
        eq(nbfcScoreOverrides.score_type, input.score_type),
        eq(nbfcScoreOverrides.is_active, true),
      ),
    );

  const [row] = await db
    .insert(nbfcScoreOverrides)
    .values({
      loan_application_id: input.loan_application_id,
      score_type: input.score_type,
      computed_score_value: String(input.computed_score_value),
      override_value: String(input.override_value),
      reason: input.reason,
      created_by: input.created_by,
      is_active: true,
    })
    .returning();

  // Step 7: append audit_logs row.
  await db.insert(auditLogs).values({
    id: `score.override.created-${row.id}-${randomUUID()}`,
    entity_type: "nbfc_score_override",
    entity_id: row.id,
    action: "score.override.created",
    performed_by: input.created_by,
    new_data: {
      tenant_id: input.tenant_id,
      loan_application_id: input.loan_application_id,
      score_type: input.score_type,
      computed_score_value: input.computed_score_value,
      override_value: input.override_value,
      reason: input.reason,
    },
  });

  return toApi(row as unknown as ScoreOverrideRow);
}

export async function getScoreOverrides(input: {
  loan_application_id: string;
  score_type: ScoreType;
}) {
  const rows = await db
    .select()
    .from(nbfcScoreOverrides)
    .where(
      and(
        eq(
          nbfcScoreOverrides.loan_application_id,
          input.loan_application_id,
        ),
        eq(nbfcScoreOverrides.score_type, input.score_type),
      ),
    )
    .orderBy(desc(nbfcScoreOverrides.created_at));

  const mapped = rows.map((r) =>
    toApi(r as unknown as ScoreOverrideRow),
  );
  const active = mapped.find((r) => r.is_active) ?? null;
  return { active_override: active, history: mapped };
}
