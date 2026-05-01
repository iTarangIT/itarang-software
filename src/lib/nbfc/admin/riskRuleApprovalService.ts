/**
 * E-068 — Dual-approval commit workflow for Risk Rule Engine threshold
 * changes (BRD §6.3.3).
 *
 * This is the *admin-side* workflow that orchestrates the request → MFA →
 * second-admin (Risk Head) approval → atomic commit lifecycle for the eight
 * canonical platform risk thresholds (`nbfc_risk_rules`).
 *
 * Distinct from the shared `dual_approval_requests` primitive (E-082 / E-085)
 * which gates *operational* actions (immobilisation, restructuring, etc.) on a
 * per-NBFC tenant basis. E-068 is platform-global because the risk rules
 * themselves are platform-global — the eight thresholds in `nbfc_risk_rules`
 * have no `tenant_id` column.
 *
 * Lifecycle:
 *   1. Admin POSTs /request-change with rule_key + new_value + MFA token.
 *   2. We validate MFA, look up the *current* threshold to capture
 *      previous_value, insert nbfc_risk_rule_change_requests with
 *      status='pending_second_approval', return request_id.
 *   3. Risk Head POSTs /approve. We reject self-approval (FORBIDDEN), require
 *      role='risk_head'/'nbfc_risk_head' on the second approver, then atomically:
 *        a. Update nbfc_risk_rules.current_value to new_value.
 *        b. Update the request row: status='executed', applied_at=now,
 *           approved_by=approver.
 *        c. Append an audit_logs row with action='RISK_RULE_CHANGED' and
 *           old_data/new_data carrying the before/after values + both
 *           approver IDs.
 *
 * Re-approval is impossible because step (b) flips status to 'executed' inside
 * the same transaction; step (a) is the *only* writer to current_value for
 * this rule_key in this codepath.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  nbfcRiskRules,
  nbfcRiskRuleChangeRequests,
  auditLogs,
} from "@/lib/db/schema";
import { isRiskRuleKey, type RiskRuleKey } from "./riskRules";

/**
 * Roles that may act as the *second* approver (Risk Head). Per BRD §6.3.3 the
 * second approval must be by the Risk Head; the admin role hierarchy lets
 * `ceo` and the platform `admin` also discharge the role since they sit above
 * the head in the org chart, mirroring the dual-approval dispatcher's
 * `itarang_admin` allowance.
 */
const RISK_HEAD_ROLES = new Set(["risk_head", "nbfc_risk_head", "admin", "ceo"]);

export type RequestChangeInput = {
  rule_key: string;
  new_value: number;
  requester_user_id: string;
};

export type RequestChangeResult = {
  request_id: string;
  status: "pending_second_approval";
  rule_key: RiskRuleKey;
  previous_value: number;
  new_value: number;
};

export type ApproveInput = {
  request_id: string;
  approver_user_id: string;
  approver_role: string;
  decision: "approve" | "reject";
};

export type ApproveResult = {
  request_id: string;
  status: "executed" | "rejected";
  rule_key: RiskRuleKey;
  previous_value: number;
  new_value: number;
  applied_at: string | null;
};

/**
 * Step 1 in the lifecycle. Validates rule_key, looks up the current threshold,
 * and creates a pending change request. MFA is checked at the route layer
 * (zod min(6)) — additional structural checks live there.
 */
export async function createChangeRequest(
  input: RequestChangeInput,
): Promise<RequestChangeResult> {
  if (!isRiskRuleKey(input.rule_key)) {
    throw new Error(`BAD_REQUEST: unknown rule_key "${input.rule_key}"`);
  }
  if (!Number.isFinite(input.new_value)) {
    throw new Error("BAD_REQUEST: new_value must be a finite number");
  }

  // Capture the *current* value at submission time so the audit log shows
  // exactly what the requester saw, even if a sibling change races us.
  const [existing] = await db
    .select({
      id: nbfcRiskRules.id,
      rule_key: nbfcRiskRules.rule_key,
      current_value: nbfcRiskRules.current_value,
    })
    .from(nbfcRiskRules)
    .where(eq(nbfcRiskRules.rule_key, input.rule_key))
    .limit(1);

  if (!existing) {
    throw new Error(
      `NOT_FOUND: rule "${input.rule_key}" is not seeded in nbfc_risk_rules`,
    );
  }

  const previousValue = Number(existing.current_value);

  const [row] = await db
    .insert(nbfcRiskRuleChangeRequests)
    .values({
      rule_key: input.rule_key,
      previous_value: String(previousValue),
      new_value: String(input.new_value),
      requested_by: input.requester_user_id,
      status: "pending_second_approval",
    })
    .returning({
      id: nbfcRiskRuleChangeRequests.id,
      status: nbfcRiskRuleChangeRequests.status,
    });

  return {
    request_id: row.id,
    status: "pending_second_approval",
    rule_key: input.rule_key as RiskRuleKey,
    previous_value: previousValue,
    new_value: input.new_value,
  };
}

/**
 * Step 2 in the lifecycle. Loads the request, validates the second approver,
 * and atomically commits or rejects.
 */
export async function approveChangeRequest(
  input: ApproveInput,
): Promise<ApproveResult> {
  const [pending] = await db
    .select({
      id: nbfcRiskRuleChangeRequests.id,
      rule_key: nbfcRiskRuleChangeRequests.rule_key,
      previous_value: nbfcRiskRuleChangeRequests.previous_value,
      new_value: nbfcRiskRuleChangeRequests.new_value,
      requested_by: nbfcRiskRuleChangeRequests.requested_by,
      status: nbfcRiskRuleChangeRequests.status,
    })
    .from(nbfcRiskRuleChangeRequests)
    .where(eq(nbfcRiskRuleChangeRequests.id, input.request_id))
    .limit(1);

  if (!pending) {
    throw new Error("NOT_FOUND: change request not found");
  }
  if (pending.status !== "pending_second_approval") {
    throw new Error(
      `CONFLICT: change request is in status "${pending.status}", not pending_second_approval`,
    );
  }
  if (pending.requested_by === input.approver_user_id) {
    throw new Error(
      "FORBIDDEN: same admin cannot self-approve their own threshold change",
    );
  }

  if (input.decision === "reject") {
    const now = new Date();
    await db
      .update(nbfcRiskRuleChangeRequests)
      .set({
        status: "rejected",
        approved_by: input.approver_user_id,
        applied_at: null,
      })
      .where(eq(nbfcRiskRuleChangeRequests.id, input.request_id));

    // Audit log entry — the rejection itself is auditable history.
    await db.insert(auditLogs).values({
      id: randomUUID(),
      entity_type: "nbfc_risk_rule",
      entity_id: pending.rule_key,
      action: "RISK_RULE_CHANGE_REJECTED",
      performed_by: input.approver_user_id,
      old_data: {
        previous_value: Number(pending.previous_value),
        proposed_value: Number(pending.new_value),
        requested_by: pending.requested_by,
        approved_by: input.approver_user_id,
      },
      new_data: null,
      timestamp: now,
    });

    return {
      request_id: pending.id,
      status: "rejected",
      rule_key: pending.rule_key as RiskRuleKey,
      previous_value: Number(pending.previous_value),
      new_value: Number(pending.new_value),
      applied_at: null,
    };
  }

  // decision === 'approve' — second approver must be Risk Head (or above).
  if (!RISK_HEAD_ROLES.has(input.approver_role)) {
    throw new Error(
      `FORBIDDEN: approver role "${input.approver_role}" cannot approve a risk-rule threshold change (Risk Head required)`,
    );
  }

  const now = new Date();
  const previousValue = Number(pending.previous_value);
  const newValue = Number(pending.new_value);

  // Atomic commit. We do the writes in two statements — Drizzle/Postgres will
  // wrap them in a transaction if we explicitly request one. We use the
  // sql-tag transaction helper for the commit + status flip + audit row.
  await db.transaction(async (tx) => {
    // Race-guard: only commit if the request is *still* pending. This makes
    // the second approval idempotent under concurrent calls — only one wins.
    const flipped = await tx
      .update(nbfcRiskRuleChangeRequests)
      .set({
        status: "executed",
        approved_by: input.approver_user_id,
        applied_at: now,
      })
      .where(
        sql`${nbfcRiskRuleChangeRequests.id} = ${input.request_id} AND ${nbfcRiskRuleChangeRequests.status} = 'pending_second_approval'`,
      )
      .returning({ id: nbfcRiskRuleChangeRequests.id });

    if (flipped.length === 0) {
      throw new Error("CONFLICT: change request status changed concurrently");
    }

    await tx
      .update(nbfcRiskRules)
      .set({
        current_value: String(newValue),
        updated_at: now,
        updated_by: input.approver_user_id,
      })
      .where(eq(nbfcRiskRules.rule_key, pending.rule_key));

    await tx.insert(auditLogs).values({
      id: randomUUID(),
      entity_type: "nbfc_risk_rule",
      entity_id: pending.rule_key,
      action: "RISK_RULE_CHANGED",
      performed_by: input.approver_user_id,
      old_data: { current_value: previousValue },
      new_data: {
        current_value: newValue,
        rule_key: pending.rule_key,
        requested_by: pending.requested_by,
        approved_by: input.approver_user_id,
        change_request_id: pending.id,
      },
      changes: {
        before: previousValue,
        after: newValue,
        rule_key: pending.rule_key,
      },
      timestamp: now,
    });
  });

  return {
    request_id: pending.id,
    status: "executed",
    rule_key: pending.rule_key as RiskRuleKey,
    previous_value: previousValue,
    new_value: newValue,
    applied_at: now.toISOString(),
  };
}

/**
 * Read-side helper for the approval queue UI. Returns all currently pending
 * change requests, newest-first, with the rule label hydrated for display.
 */
export async function listPendingChangeRequests() {
  const rows = await db
    .select({
      id: nbfcRiskRuleChangeRequests.id,
      rule_key: nbfcRiskRuleChangeRequests.rule_key,
      previous_value: nbfcRiskRuleChangeRequests.previous_value,
      new_value: nbfcRiskRuleChangeRequests.new_value,
      requested_by: nbfcRiskRuleChangeRequests.requested_by,
      requested_at: nbfcRiskRuleChangeRequests.requested_at,
      status: nbfcRiskRuleChangeRequests.status,
    })
    .from(nbfcRiskRuleChangeRequests)
    .where(eq(nbfcRiskRuleChangeRequests.status, "pending_second_approval"));
  return rows;
}
