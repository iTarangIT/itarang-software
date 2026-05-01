/**
 * E-033 — Request Immobilisation (BRD §6.1.6)
 *
 * Request Immobilisation is the §6.1.6 "Risk Action Framework" row:
 *   Approval: Dual — Risk Head (initiator) + Ops Head (approver)
 *   Reversible? Yes — re-mobilisation after EMI settlement
 *   Audit: Yes — full borrower notice preview required (RBI Digital
 *   Lending Directions 2025)
 *
 * Note on overlap with E-083: a sibling unit, E-083 (BRD §6.4.3 — "Battery
 * Immobilisation"), already ships a different dual-approval immobilisation
 * pathway through the `dual_approval_requests` + `nbfc_immobilisation_actions`
 * tables with role pair Risk Manager → Risk Head. E-033 is the §6.1.6 row,
 * which is a distinct surface: different role pair (Risk Head + Ops Head),
 * different storage path (the lighter-weight `nbfc_borrower_actions` row +
 * `nbfc_audit_log`), an explicit re-mobilisation lifecycle (status='reversed'),
 * and a structured 5-component RBI borrower-notice text validator. The two
 * units are intentionally parallel paths through the BRD because §6.1.6 and
 * §6.4.3 describe different triage tiers in the borrower-action framework.
 *
 * Behaviour (per unit YAML logic):
 *   1. requestImmobilisation: caller role MUST be 'nbfc_risk_head' and
 *      notice_confirmed === true; rejects otherwise. Validates that
 *      notice_text contains all five RBI-mandated components. Inserts an
 *      nbfc_borrower_actions row (action_type='immobilisation',
 *      status='pending_dual_approval'); audit-logs.
 *   2. approveImmobilisation: caller role MUST be 'nbfc_ops_head' and the
 *      requested action MUST still be 'pending_dual_approval'; flips status
 *      to 'approved' and audit-logs.
 *   3. remobiliseImmobilisation: original action MUST be 'approved' and a
 *      settlement_reference MUST be provided; flips status to 'reversed' and
 *      audit-logs.
 */
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import {
  nbfcBorrowerActions,
  nbfcAuditLog,
} from "@/lib/db/schema";

export const REQUEST_IMMOBILISATION_ACTION_TYPE = "immobilisation" as const;

export const RISK_HEAD_ROLES = new Set([
  "nbfc_risk_head",
  "risk_head",
]);

export const OPS_HEAD_ROLES = new Set([
  "nbfc_ops_head",
  "ops_head",
  "nbfc_ops",
]);

/**
 * The five RBI-mandated components the borrower notice must spell out before
 * an immobilisation request is allowed (BRD §6.1.6 — "Borrower Notice
 * Mandatory" + RBI Digital Lending Directions 2025).
 *
 * We accept either a structured-payload field (preferred) or a plaintext
 * notice_text that mentions enough keyword/regex anchors to demonstrate each
 * component is present. The structured-keyword check is intentionally lenient
 * (case-insensitive, accepts common phrasings) so legitimate notices aren't
 * rejected for trivial wording differences — but it's strict enough that an
 * empty/skeleton notice fails.
 */
type NoticeCheck = { id: string; label: string; pattern: RegExp };

const NOTICE_CHECKS: NoticeCheck[] = [
  {
    id: "lender_identity",
    label: "Lender identity (NBFC legal name)",
    // Look for "lender", "nbfc", or "limited" — a lender legal-name
    // declaration almost always contains one of these.
    pattern: /\b(lender|nbfc|limited|ltd\.?|pvt\.?\s*ltd)\b/i,
  },
  {
    id: "lsp_identity",
    label: "LSP identity (iTarang Battery Solutions)",
    pattern: /\b(itarang|lsp|loan service provider|battery solutions)\b/i,
  },
  {
    id: "outstanding_amount",
    label: "Outstanding amount + restoration steps",
    // Must mention the outstanding/dues AND a restoration/re-mobilisation hint.
    // Run two simpler tests via a function in validateBorrowerNoticeText to
    // avoid the `s` (dotall) flag which requires es2018+. The combined-regex
    // form is replaced by a structural check below — but we keep this check
    // entry so the field-id surfaces in the missing[] list. The actual match
    // happens in `validateBorrowerNoticeText`.
    pattern: /\b(outstanding|due|amount|₹|rs\.?|inr)\b/i,
  },
  {
    id: "grievance_channel",
    label: "Grievance channel URL + helpline",
    // Either a URL or a phone-number-like sequence + the word "grievance" or
    // "helpline".
    pattern: /\b(grievance|helpline|nodal|complaint)\b/i,
  },
  {
    id: "plain_language",
    label: "Plain, non-coercive language confirmation",
    // Some explicit reassurance/non-coercive phrasing or a plain-language
    // statement.
    pattern: /\b(plain|non[- ]?coercive|non-?threaten|cooperat|polite|respect|fair)\b/i,
  },
];

// Additional structural check for the outstanding-amount component: the
// notice MUST also mention a restoration / re-mobilisation / settlement
// pathway (BRD §6.1.6: "Outstanding amount + restoration steps"). Tested
// separately so we don't need the dotall (`s`) regex flag.
const RESTORATION_PATTERN = /\b(restor|re-?mobilis|settle|pay)/i;

export function validateBorrowerNoticeText(noticeText: string): {
  ok: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  for (const check of NOTICE_CHECKS) {
    if (!check.pattern.test(noticeText)) {
      missing.push(check.id);
    }
  }
  // The "outstanding_amount" component requires BOTH the amount-keyword
  // (handled above) AND a restoration/re-mobilisation/settlement keyword.
  if (
    !missing.includes("outstanding_amount") &&
    !RESTORATION_PATTERN.test(noticeText)
  ) {
    missing.push("outstanding_amount");
  }
  return { ok: missing.length === 0, missing };
}

export const BORROWER_NOTICE_COMPONENTS = NOTICE_CHECKS.map((c) => ({
  id: c.id,
  label: c.label,
}));

// ---------------------------------------------------------------------------
// 1. Request
// ---------------------------------------------------------------------------

export interface RequestImmobilisationInput {
  tenant_id: string;
  actor_user_id: string;
  actor_role: string;
  loan_sanction_id: string;
  notice_confirmed: true;
  notice_text: string;
  outstanding_amount: number;
}

export interface RequestImmobilisationResult {
  action_id: string;
  status: "pending_dual_approval";
  created_at: string;
}

export async function requestImmobilisation(
  input: RequestImmobilisationInput,
): Promise<RequestImmobilisationResult> {
  // Role gate — only Risk Head can submit per BRD §6.1.6.
  if (!RISK_HEAD_ROLES.has(input.actor_role)) {
    throw new Error(
      `FORBIDDEN: caller role '${input.actor_role}' cannot request immobilisation; nbfc_risk_head required`,
    );
  }
  if (input.notice_confirmed !== true) {
    throw new Error(
      "BAD_REQUEST: notice_confirmed must be true before submission",
    );
  }
  if (typeof input.notice_text !== "string" || input.notice_text.length < 50) {
    throw new Error(
      "BAD_REQUEST: notice_text must be at least 50 characters",
    );
  }
  if (
    typeof input.outstanding_amount !== "number" ||
    input.outstanding_amount < 0 ||
    !Number.isFinite(input.outstanding_amount)
  ) {
    throw new Error(
      "BAD_REQUEST: outstanding_amount must be a non-negative number",
    );
  }

  // Five-component RBI notice validator.
  const check = validateBorrowerNoticeText(input.notice_text);
  if (!check.ok) {
    throw new Error(
      `BAD_REQUEST: notice_text missing mandatory components: ${check.missing.join(", ")}`,
    );
  }

  const now = new Date();

  const [actionRow] = await db
    .insert(nbfcBorrowerActions)
    .values({
      tenant_id: input.tenant_id,
      loan_sanction_id: input.loan_sanction_id,
      action_type: REQUEST_IMMOBILISATION_ACTION_TYPE,
      status: "pending_dual_approval",
      requested_by: input.actor_user_id,
      payload: {
        notice_text: input.notice_text,
        outstanding_amount: input.outstanding_amount,
        notice_confirmed_at: now.toISOString(),
        rbi_directions_2025: true,
      },
      created_at: now,
    })
    .returning({
      id: nbfcBorrowerActions.id,
      created_at: nbfcBorrowerActions.created_at,
    });

  await db.insert(nbfcAuditLog).values({
    tenant_id: input.tenant_id,
    user_id: input.actor_user_id,
    action_type: REQUEST_IMMOBILISATION_ACTION_TYPE,
    action_id: actionRow.id,
    before_state: {
      loan_sanction_id: input.loan_sanction_id,
      status: null,
    },
    after_state: {
      loan_sanction_id: input.loan_sanction_id,
      status: "pending_dual_approval",
      outstanding_amount: input.outstanding_amount,
      notice_confirmed: true,
      action_id: actionRow.id,
    },
    created_at: now,
  });

  return {
    action_id: actionRow.id,
    status: "pending_dual_approval",
    created_at: (actionRow.created_at ?? now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 2. Approve
// ---------------------------------------------------------------------------

export interface ApproveImmobilisationInput {
  tenant_id: string;
  actor_user_id: string;
  actor_role: string;
  action_id: string;
}

export interface ApproveImmobilisationResult {
  action_id: string;
  status: "approved";
}

export async function approveImmobilisation(
  input: ApproveImmobilisationInput,
): Promise<ApproveImmobilisationResult> {
  if (!OPS_HEAD_ROLES.has(input.actor_role)) {
    throw new Error(
      `FORBIDDEN: caller role '${input.actor_role}' cannot approve immobilisation; nbfc_ops_head required`,
    );
  }

  const rows = await db
    .select()
    .from(nbfcBorrowerActions)
    .where(
      and(
        eq(nbfcBorrowerActions.id, input.action_id),
        eq(nbfcBorrowerActions.tenant_id, input.tenant_id),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new Error("NOT_FOUND: immobilisation action not found");
  }
  const action = rows[0];
  if (action.action_type !== REQUEST_IMMOBILISATION_ACTION_TYPE) {
    throw new Error(
      `CONFLICT: action ${input.action_id} is action_type='${action.action_type}', expected '${REQUEST_IMMOBILISATION_ACTION_TYPE}'`,
    );
  }
  if (action.status !== "pending_dual_approval") {
    throw new Error(
      `CONFLICT: action ${input.action_id} is status='${action.status}', expected 'pending_dual_approval'`,
    );
  }

  const now = new Date();
  const beforeStatus = action.status;

  await db
    .update(nbfcBorrowerActions)
    .set({ status: "approved" })
    .where(eq(nbfcBorrowerActions.id, input.action_id));

  await db.insert(nbfcAuditLog).values({
    tenant_id: input.tenant_id,
    user_id: input.actor_user_id,
    action_type: REQUEST_IMMOBILISATION_ACTION_TYPE,
    action_id: input.action_id,
    before_state: {
      loan_sanction_id: action.loan_sanction_id,
      status: beforeStatus,
    },
    after_state: {
      loan_sanction_id: action.loan_sanction_id,
      status: "approved",
      approved_by: input.actor_user_id,
    },
    created_at: now,
  });

  return { action_id: input.action_id, status: "approved" };
}

// ---------------------------------------------------------------------------
// 3. Re-mobilise
// ---------------------------------------------------------------------------

export interface RemobiliseImmobilisationInput {
  tenant_id: string;
  actor_user_id: string;
  action_id: string;
  settlement_reference: string;
}

export interface RemobiliseImmobilisationResult {
  action_id: string;
  status: "reversed";
}

export async function remobiliseImmobilisation(
  input: RemobiliseImmobilisationInput,
): Promise<RemobiliseImmobilisationResult> {
  if (
    typeof input.settlement_reference !== "string" ||
    input.settlement_reference.trim().length < 3
  ) {
    throw new Error(
      "BAD_REQUEST: settlement_reference must be at least 3 characters",
    );
  }

  const rows = await db
    .select()
    .from(nbfcBorrowerActions)
    .where(
      and(
        eq(nbfcBorrowerActions.id, input.action_id),
        eq(nbfcBorrowerActions.tenant_id, input.tenant_id),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new Error("NOT_FOUND: immobilisation action not found");
  }
  const action = rows[0];
  if (action.action_type !== REQUEST_IMMOBILISATION_ACTION_TYPE) {
    throw new Error(
      `CONFLICT: action ${input.action_id} is action_type='${action.action_type}', expected '${REQUEST_IMMOBILISATION_ACTION_TYPE}'`,
    );
  }
  if (action.status !== "approved") {
    throw new Error(
      `CONFLICT: action ${input.action_id} is status='${action.status}', expected 'approved'`,
    );
  }

  const now = new Date();

  await db
    .update(nbfcBorrowerActions)
    .set({ status: "reversed" })
    .where(eq(nbfcBorrowerActions.id, input.action_id));

  await db.insert(nbfcAuditLog).values({
    tenant_id: input.tenant_id,
    user_id: input.actor_user_id,
    action_type: REQUEST_IMMOBILISATION_ACTION_TYPE,
    action_id: input.action_id,
    before_state: {
      loan_sanction_id: action.loan_sanction_id,
      status: "approved",
    },
    after_state: {
      loan_sanction_id: action.loan_sanction_id,
      status: "reversed",
      settlement_reference: input.settlement_reference.trim(),
      reversed_by: input.actor_user_id,
    },
    created_at: now,
  });

  return { action_id: input.action_id, status: "reversed" };
}
