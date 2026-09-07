/**
 * E-283 — multi-party delete for a customer application (`leads`).
 *
 * Before this, "delete" existed in exactly one place — the dealer's Lead
 * Management list — and it was a hard cascade: one dealer click removed the
 * lead row and every child record, including the copy the admin was reviewing
 * and the file an NBFC had under credit assessment.
 *
 * Now each party deletes from its OWN dashboard and it disappears from its OWN
 * list. The underlying application is purged only once every party that
 * actually holds it has deleted it:
 *
 *   dealer  — always required (the lead always belongs to a dealer)
 *   admin   — required once the application has reached an admin surface:
 *             a submit-for-verification row, or a submitted product selection
 *   NBFC    — required per tenant, for every lender the lead was routed to
 *
 * The "required" qualifiers matter: a dealer discarding a junk lead nobody else
 * has ever seen still gets an immediate, complete delete, exactly as before.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { isFullyDeleted, type LeadDeleteState } from "./delete-policy";

export type DeleteScope = "dealer" | "admin" | "nbfc";

// The purge rule itself lives in delete-policy.ts, which imports nothing — it
// is the one piece of this module that can be unit-tested.
export { isFullyDeleted } from "./delete-policy";
export type { LeadDeleteState } from "./delete-policy";

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/** node-postgres returns { rows }, some drivers return the array itself. */
function firstRow(result: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(result)) return result[0] as Record<string, unknown> | undefined;
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
}

/**
 * The hard cascade — lifted verbatim out of the dealer DELETE route, which used
 * to run it on every click. It now runs in exactly one place: the moment the
 * last party deletes.
 *
 * Order matters (children before parents). `approvals` is keyed on
 * (entity_type, entity_id) against `deals` rather than on lead_id, so it has to
 * be cleared through a subquery BEFORE deals go.
 */
export async function purgeLeadCascade(tx: Executor, leadId: string): Promise<void> {
  await tx.execute(sql`
    DELETE FROM approvals
    WHERE entity_type = 'deal'
      AND entity_id IN (SELECT id FROM deals WHERE lead_id = ${leadId})
  `);

  await tx.execute(sql`DELETE FROM kyc_documents WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM kyc_verifications WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM consent_records WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM personal_details WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM lead_products WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM co_borrower_documents WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM co_borrowers WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM admin_kyc_reviews WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM other_document_requests WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM loan_offers WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM loan_applications WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM loan_files WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM facilitation_payments WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM lead_assignments WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM assignment_change_logs WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM deals WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM bolna_calls WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM ai_call_logs WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM call_records WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM deployed_assets WHERE lead_id = ${leadId}`);

  // E-283 — the rows the admin and NBFC surfaces are driven by. They were not
  // in the dealer cascade before because the dealer could not previously be the
  // last deleter of a file those parties held; now the purge only happens once
  // every party has deleted, and these go with the lead.
  await tx.execute(sql`DELETE FROM nbfc_lead_assignments WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM admin_verification_queue WHERE lead_id = ${leadId}`);
  await tx.execute(sql`DELETE FROM product_selections WHERE lead_id = ${leadId}`);

  await tx.execute(sql`UPDATE coupon_codes SET reserved_for_lead_id = NULL WHERE reserved_for_lead_id = ${leadId}`);
  await tx.execute(sql`UPDATE coupon_codes SET used_by_lead_id = NULL WHERE used_by_lead_id = ${leadId}`);
  await tx.execute(sql`UPDATE coupon_audit_log SET lead_id = NULL WHERE lead_id = ${leadId}`);
  await tx.execute(sql`UPDATE scraped_dealer_leads SET converted_lead_id = NULL WHERE converted_lead_id = ${leadId}`);

  await tx.execute(sql`DELETE FROM leads WHERE id = ${leadId}`);
}

/** Read the three parties' delete state for one lead. */
export async function readDeleteState(
  tx: Executor,
  leadId: string,
): Promise<LeadDeleteState | null> {
  const result = await tx.execute(sql`
    SELECT
      l.deleted_by_dealer_at AS dealer_deleted_at,
      l.deleted_by_admin_at  AS admin_deleted_at,
      (
        EXISTS (SELECT 1 FROM admin_verification_queue q WHERE q.lead_id = l.id)
        OR EXISTS (SELECT 1 FROM product_selections p WHERE p.lead_id = l.id)
      ) AS admin_holds,
      (
        SELECT COUNT(*) FROM nbfc_lead_assignments a
        WHERE a.lead_id = l.id AND a.deleted_at IS NULL
      )::int AS live_nbfc
    FROM leads l
    WHERE l.id = ${leadId}
  `);

  const row = firstRow(result);
  if (!row) return null;

  return {
    dealerDeletedAt: (row.dealer_deleted_at as Date | null) ?? null,
    adminDeletedAt: (row.admin_deleted_at as Date | null) ?? null,
    adminHolds: Boolean(row.admin_holds),
    liveNbfcAssignments: Number(row.live_nbfc ?? 0),
  };
}

export interface MarkDeletedInput {
  leadId: string;
  scope: DeleteScope;
  /** users.id (uuid) of whoever clicked delete. */
  userId: string | null;
  /** Required for scope 'nbfc' — only that tenant's assignments are hidden. */
  tenantId?: string;
}

export interface MarkDeletedResult {
  /** True when this delete was the last one outstanding and the row was destroyed. */
  purged: boolean;
  state: LeadDeleteState;
}

function auditId(): string {
  return `AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Record one party's delete, then purge if that was the last one outstanding.
 * Both halves run in one transaction behind a row lock on the lead, so two
 * parties clicking delete at the same moment cannot each read "one still left"
 * and leave the application orphaned with nobody able to see it.
 */
export async function markLeadDeleted(
  input: MarkDeletedInput,
): Promise<MarkDeletedResult> {
  const { leadId, scope, userId, tenantId } = input;
  if (scope === "nbfc" && !tenantId) {
    throw new Error("markLeadDeleted: scope 'nbfc' requires a tenantId");
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM leads WHERE id = ${leadId} FOR UPDATE`);

    if (scope === "dealer") {
      await tx.execute(sql`
        UPDATE leads
        SET deleted_by_dealer_at = COALESCE(deleted_by_dealer_at, now()),
            deleted_by_dealer_user = COALESCE(deleted_by_dealer_user, ${userId}::uuid)
        WHERE id = ${leadId}
      `);
    } else if (scope === "admin") {
      await tx.execute(sql`
        UPDATE leads
        SET deleted_by_admin_at = COALESCE(deleted_by_admin_at, now()),
            deleted_by_admin_user = COALESCE(deleted_by_admin_user, ${userId}::uuid)
        WHERE id = ${leadId}
      `);
    } else {
      await tx.execute(sql`
        UPDATE nbfc_lead_assignments
        SET deleted_at = COALESCE(deleted_at, now()),
            deleted_by_user = COALESCE(deleted_by_user, ${userId}::uuid),
            updated_at = now()
        WHERE lead_id = ${leadId} AND tenant_id = ${tenantId}::uuid
      `);
    }

    const state = await readDeleteState(tx, leadId);
    if (!state) throw new Error(`markLeadDeleted: lead ${leadId} not found`);

    await tx.execute(sql`
      INSERT INTO audit_logs (id, entity_type, entity_id, action, changes, performed_by, timestamp)
      VALUES (
        ${auditId()}, 'lead', ${leadId}, 'LEAD_DELETE_MARKED',
        ${JSON.stringify({ scope, tenant_id: tenantId ?? null, deleted_by: userId })}::jsonb,
        ${userId}::uuid, now()
      )
    `);

    if (!isFullyDeleted(state)) {
      return { purged: false, state };
    }

    // Written BEFORE the cascade: the audit row is the only thing that survives
    // it, and it has to say who fired the last shot.
    await tx.execute(sql`
      INSERT INTO audit_logs (id, entity_type, entity_id, action, changes, performed_by, timestamp)
      VALUES (
        ${auditId()}, 'lead', ${leadId}, 'LEAD_PURGED',
        ${JSON.stringify({ final_scope: scope, deleted_by: userId })}::jsonb,
        ${userId}::uuid, now()
      )
    `);

    await purgeLeadCascade(tx, leadId);
    return { purged: true, state };
  });
}
