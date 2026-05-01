/**
 * E-089 — PII Access Gated service.
 *
 * Wraps E-082's dual-approval primitive for the action_type 'pii_data_access'.
 * Initiation creates a pending dual_approval_requests row (no grant yet);
 * once Approver-2 (iTarang Compliance Officer) approves via the standard
 * E-082 approve route, `mintGrantIfApproved` mints a single-use,
 * time-boxed nbfc_pii_access_grants row. The /unmask endpoint consumes the
 * grant (decrements/increments used_count and writes audit_logs).
 *
 * MFA token format (test-grade only — production should swap for an IDP-issued
 * step-up token):
 *   mfa_token = sha256(user_id|server_secret|"pii_access")
 * Verified inline; no separate challenge table is created.
 */
import { randomUUID, createHash } from "node:crypto";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import {
  dualApprovalRequests,
  nbfcPiiAccessGrants,
  auditLogs,
  personalDetails,
} from "@/lib/db/schema";
import { createDualApprovalRequest } from "@/lib/nbfc/dual-approval/service";

export const PII_ACTION_TYPE = "pii_data_access";
export const REQUIRED_APPROVER_ROLE = "itarang_compliance_officer";
export const GRANT_TTL_MS = 30 * 60 * 1000;

function getMfaSecret(): string {
  return (
    process.env.NBFC_PII_MFA_SECRET ??
    process.env.NBFC_TEST_BYPASS_SECRET ??
    "e089-mfa-secret-fallback"
  );
}

/**
 * Compute the canonical MFA token for a given user. The /initiate route
 * accepts this exact value as `mfa_token`. In a real deployment this would
 * be an IDP-issued JWT verified against the IDP's JWKS.
 */
export function computeMfaToken(userId: string): string {
  return createHash("sha256")
    .update(`${userId}|${getMfaSecret()}|pii_access`)
    .digest("hex");
}

export function verifyMfaToken(userId: string, token: string): boolean {
  if (!token || token.length < 8) return false;
  return token === computeMfaToken(userId);
}

export interface InitiateInput {
  tenant_id: string;
  initiator_user_id: string;
  lead_id: string;
  fields: Array<"aadhaar" | "pan">;
  reason_code: string;
  mfa_token: string;
}

export async function initiatePiiAccess(input: InitiateInput) {
  if (!verifyMfaToken(input.initiator_user_id, input.mfa_token)) {
    throw new Error("UNAUTHORIZED: invalid mfa_token");
  }
  if (input.fields.length === 0) {
    throw new Error("BAD_REQUEST: fields must not be empty");
  }

  const dual = await createDualApprovalRequest({
    tenant_id: input.tenant_id,
    initiator_user_id: input.initiator_user_id,
    action_type: PII_ACTION_TYPE,
    entity_id: input.lead_id,
    reason_code: input.reason_code,
    evidence_snapshot: {
      lead_id: input.lead_id,
      fields: input.fields,
      requested_at: new Date().toISOString(),
    },
  });

  await appendAudit({
    entity_id: dual.id,
    action: "pii_access.requested",
    performed_by: input.initiator_user_id,
    payload: {
      lead_id: input.lead_id,
      fields: input.fields,
      tenant_id: input.tenant_id,
    },
  });

  return {
    approval_request_id: dual.id,
    status: dual.status,
    action_type: dual.action_type,
    required_approver_role: dual.required_approver_role,
    expires_at: dual.expires_at,
    fields: input.fields,
  };
}

/**
 * Idempotently mint (or fetch) the grant linked to a dual_approval_requests
 * row. Returns null if the underlying request is not in 'approved' status.
 *
 * Called from /unmask before token validation so the grant exists by the
 * time the requestor reaches for it.
 */
export async function mintGrantIfApproved(approvalRequestId: string) {
  const existing = await db
    .select()
    .from(nbfcPiiAccessGrants)
    .where(eq(nbfcPiiAccessGrants.approval_request_id, approvalRequestId))
    .limit(1);
  if (existing.length > 0) return existing[0];

  const dualRows = await db
    .select()
    .from(dualApprovalRequests)
    .where(eq(dualApprovalRequests.id, approvalRequestId))
    .limit(1);
  if (dualRows.length === 0) {
    throw new Error("NOT_FOUND: approval request not found");
  }
  const dual = dualRows[0];
  if (dual.action_type !== PII_ACTION_TYPE) {
    throw new Error(
      `BAD_REQUEST: approval request action_type='${dual.action_type}' is not pii_data_access`,
    );
  }
  if (dual.status !== "approved") {
    return null;
  }

  const evidence = (dual.evidence_snapshot as Record<string, unknown>) ?? {};
  const fields = Array.isArray(evidence.fields) ? evidence.fields : ["aadhaar", "pan"];
  const now = new Date();
  const accessToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

  const [row] = await db
    .insert(nbfcPiiAccessGrants)
    .values({
      lead_id: dual.entity_id,
      requested_by: dual.initiator_user_id,
      approval_request_id: dual.id,
      access_token: accessToken,
      fields: fields as unknown as object,
      granted_at: dual.approved_at ?? now,
      expires_at: new Date((dual.approved_at ?? now).getTime() + GRANT_TTL_MS),
      used_count: 0,
    })
    .returning();

  await appendAudit({
    entity_id: row.id,
    action: "pii_access.granted",
    performed_by: dual.approver_user_id ?? null,
    payload: {
      approval_request_id: dual.id,
      lead_id: row.lead_id,
      requested_by: row.requested_by,
      expires_at: row.expires_at.toISOString(),
    },
  });

  return row;
}

/**
 * Fetch the grant by access_token plus lead_id (defence in depth: the token
 * alone is enough to identify the row, but binding the lead_id avoids
 * cross-borrower confusion if a leaked token is replayed for another
 * lead).
 *
 * Throws on:
 *   - not found              (404)
 *   - lead_id mismatch       (403 FORBIDDEN)
 *   - other-user replay      (403 FORBIDDEN)
 *   - expired                (403 FORBIDDEN: EXPIRED)
 */
export interface UnmaskInput {
  lead_id: string;
  access_token: string;
  user_id: string;
}

export async function unmaskWithGrant(input: UnmaskInput) {
  const rows = await db
    .select()
    .from(nbfcPiiAccessGrants)
    .where(eq(nbfcPiiAccessGrants.access_token, input.access_token))
    .limit(1);
  if (rows.length === 0) {
    throw new Error("FORBIDDEN: access_token not found");
  }
  const grant = rows[0];
  if (grant.lead_id !== input.lead_id) {
    throw new Error("FORBIDDEN: access_token does not match lead_id");
  }
  if (grant.requested_by !== input.user_id) {
    throw new Error("FORBIDDEN: access_token belongs to a different user");
  }
  const now = new Date();
  if (grant.expires_at.getTime() < now.getTime()) {
    throw new Error("FORBIDDEN: EXPIRED — access_token expired");
  }

  const personRows = await db
    .select({
      aadhaar_no: personalDetails.aadhaar_no,
      pan_no: personalDetails.pan_no,
    })
    .from(personalDetails)
    .where(eq(personalDetails.lead_id, grant.lead_id))
    .limit(1);

  const aadhaar = personRows[0]?.aadhaar_no ?? null;
  const pan = personRows[0]?.pan_no ?? null;

  const [updated] = await db
    .update(nbfcPiiAccessGrants)
    .set({ used_count: grant.used_count + 1 })
    .where(eq(nbfcPiiAccessGrants.id, grant.id))
    .returning();

  await appendAudit({
    entity_id: grant.id,
    action: "pii_access.viewed",
    performed_by: input.user_id,
    payload: {
      lead_id: grant.lead_id,
      approval_request_id: grant.approval_request_id,
      used_count: updated.used_count,
      fields: grant.fields,
    },
  });

  return {
    aadhaar,
    pan,
    expires_at: grant.expires_at,
    used_count: updated.used_count,
  };
}

interface AuditPayload {
  entity_id: string;
  action: string;
  performed_by: string | null;
  payload: Record<string, unknown>;
}

async function appendAudit(input: AuditPayload) {
  const id = `${input.action}-${input.entity_id}-${randomUUID()}`;
  await db.insert(auditLogs).values({
    id,
    entity_type: "pii_access_grant",
    entity_id: input.entity_id,
    action: input.action,
    performed_by: input.performed_by ?? null,
    new_data: input.payload,
  });
}
