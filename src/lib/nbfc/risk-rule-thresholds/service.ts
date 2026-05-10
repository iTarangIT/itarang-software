/**
 * E-085 — Risk Rule Threshold Change service.
 *
 * Pure DB layer. The `initiate` API route calls `initiateThresholdChange` to
 * create a `dual_approval_requests` row whose evidence_snapshot carries the
 * proposed threshold. The `approve` API route delegates back into
 * `applyApprovedThresholdChange` once a second approver flips the dual-approval
 * row to status='approved'.
 *
 * Append-only invariant: on apply, we INSERT a fresh row with is_active=true
 * and UPDATE the previously-active row for the same rule_key to is_active=false
 * — never editing an already-applied row in place.
 */
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import {
  dualApprovalRequests,
  nbfcRiskRuleThresholds,
} from "@/lib/db/schema";
import { createDualApprovalRequest } from "@/lib/nbfc/dual-approval/service";

export const RISK_RULE_THRESHOLD_ACTION_TYPE = "risk_rule_threshold_change";

export interface InitiateInput {
  tenant_id: string;
  initiator_user_id: string;
  rule_key: string;
  current_threshold_json: Record<string, unknown>;
  proposed_threshold_json: Record<string, unknown>;
  reason_code: string;
}

export async function initiateThresholdChange(input: InitiateInput) {
  // Capture an evidence snapshot containing the current threshold and the
  // proposed threshold. The proposed threshold is what gets applied on
  // second-approver approval.
  const evidenceSnapshot = {
    rule_key: input.rule_key,
    current_threshold_json: input.current_threshold_json,
    proposed_threshold_json: input.proposed_threshold_json,
    captured_at: new Date().toISOString(),
  };

  return createDualApprovalRequest({
    tenant_id: input.tenant_id,
    initiator_user_id: input.initiator_user_id,
    action_type: RISK_RULE_THRESHOLD_ACTION_TYPE,
    entity_id: input.rule_key,
    reason_code: input.reason_code,
    evidence_snapshot: evidenceSnapshot,
  });
}

/**
 * Applies a previously-approved threshold change by:
 *  1. Flipping any currently-active row for this rule_key to is_active=false.
 *  2. Inserting a fresh row with the proposed threshold and is_active=true.
 *
 * Idempotent: if a row for this approval_request_id already exists, returns it
 * without inserting a duplicate.
 */
export async function applyApprovedThresholdChange(opts: {
  approval_request_id: string;
  applied_by: string;
}) {
  const [reqRow] = await db
    .select()
    .from(dualApprovalRequests)
    .where(eq(dualApprovalRequests.id, opts.approval_request_id))
    .limit(1);
  if (!reqRow) {
    throw new Error("NOT_FOUND: approval request not found");
  }
  if (reqRow.action_type !== RISK_RULE_THRESHOLD_ACTION_TYPE) {
    throw new Error(
      `BAD_REQUEST: approval request action_type='${reqRow.action_type}' is not a threshold change`,
    );
  }
  if (reqRow.status !== "approved") {
    throw new Error(
      `CONFLICT: approval request must be approved (got '${reqRow.status}')`,
    );
  }

  // Idempotency: if we already wrote a row for this approval, return it.
  const existing = await db
    .select()
    .from(nbfcRiskRuleThresholds)
    .where(eq(nbfcRiskRuleThresholds.approval_request_id, opts.approval_request_id))
    .limit(1);
  if (existing.length > 0) return existing[0];

  const evidence = (reqRow.evidence_snapshot as Record<string, unknown>) ?? {};
  const ruleKey =
    (evidence.rule_key as string | undefined) ?? reqRow.entity_id;
  const priorThreshold =
    (evidence.current_threshold_json as Record<string, unknown> | undefined) ??
    null;
  const newThreshold = evidence.proposed_threshold_json as
    | Record<string, unknown>
    | undefined;
  if (!newThreshold) {
    throw new Error(
      "BAD_REQUEST: evidence_snapshot is missing proposed_threshold_json",
    );
  }

  const now = new Date();

  // Step 1: deactivate the currently-active row for this rule_key (if any).
  await db
    .update(nbfcRiskRuleThresholds)
    .set({ is_active: false })
    .where(
      and(
        eq(nbfcRiskRuleThresholds.rule_key, ruleKey),
        eq(nbfcRiskRuleThresholds.is_active, true),
      ),
    );

  // Step 2: append the new active row.
  const [inserted] = await db
    .insert(nbfcRiskRuleThresholds)
    .values({
      rule_key: ruleKey,
      prior_threshold_json: priorThreshold ?? null,
      new_threshold_json: newThreshold,
      approval_request_id: opts.approval_request_id,
      applied_at: now,
      applied_by: opts.applied_by,
      is_active: true,
    })
    .returning();

  return inserted;
}
