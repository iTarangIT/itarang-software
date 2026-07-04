/**
 * GET /api/nbfc/loans/[loanSanctionId]/action-history
 *
 * Unions the three borrower-action evidentiary tables for a single loan and
 * returns them as a single timeline sorted by created_at desc:
 *   - nbfc_borrower_actions      → payment reminders, field visits, §6.1.6
 *                                   immobilisation requests, etc.
 *   - nbfc_immobilisation_actions → §6.4.3 executed IoT immobilisations
 *   - nbfc_audit_log             → append-only RBI evidence trail
 *
 * Tenant-scoped through the parent loan row.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { db } from "@/lib/db";
import { and, desc, eq } from "drizzle-orm";
import {
  nbfcBorrowerActions,
  nbfcImmobilisationActions,
  nbfcAuditLog,
  nbfcLoans,
} from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ActionHistoryItem = {
  source: "borrower_action" | "immobilisation_action" | "audit_log";
  id: string;
  action_type: string | null;
  status: string | null;
  created_at: string | null;
  payload?: unknown;
};

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ loanSanctionId: string }> },
) {
  try {
    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);

    const { loanSanctionId } = await ctx.params;
    if (!loanSanctionId) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: loanSanctionId required" },
        { status: 400 },
      );
    }

    const owner = await db
      .select({ tenant_id: nbfcLoans.tenant_id })
      .from(nbfcLoans)
      .where(
        and(
          eq(nbfcLoans.loan_application_id, loanSanctionId),
          eq(nbfcLoans.tenant_id, tenant.id),
        ),
      )
      .limit(1);
    if (owner.length === 0) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: loan not found for this tenant" },
        { status: 404 },
      );
    }

    const [borrowerActions, immobActions, auditEntries] = await Promise.all([
      db
        .select({
          id: nbfcBorrowerActions.id,
          action_type: nbfcBorrowerActions.action_type,
          status: nbfcBorrowerActions.status,
          payload: nbfcBorrowerActions.payload,
          created_at: nbfcBorrowerActions.created_at,
        })
        .from(nbfcBorrowerActions)
        .where(
          and(
            eq(nbfcBorrowerActions.tenant_id, tenant.id),
            eq(nbfcBorrowerActions.loan_sanction_id, loanSanctionId),
          ),
        )
        .orderBy(desc(nbfcBorrowerActions.created_at))
        .limit(50),
      db
        .select({
          id: nbfcImmobilisationActions.id,
          imei: nbfcImmobilisationActions.imei,
          approval_request_id: nbfcImmobilisationActions.approval_request_id,
          executed_at: nbfcImmobilisationActions.executed_at,
          borrower_notified_at:
            nbfcImmobilisationActions.borrower_notified_at,
        })
        .from(nbfcImmobilisationActions)
        .where(
          and(
            eq(nbfcImmobilisationActions.tenant_id, tenant.id),
            eq(
              nbfcImmobilisationActions.loan_application_id,
              loanSanctionId,
            ),
          ),
        )
        .orderBy(desc(nbfcImmobilisationActions.executed_at))
        .limit(50),
      db
        .select({
          id: nbfcAuditLog.id,
          action_type: nbfcAuditLog.action_type,
          action_id: nbfcAuditLog.action_id,
          before_state: nbfcAuditLog.before_state,
          after_state: nbfcAuditLog.after_state,
          created_at: nbfcAuditLog.created_at,
        })
        .from(nbfcAuditLog)
        .where(eq(nbfcAuditLog.tenant_id, tenant.id))
        .orderBy(desc(nbfcAuditLog.created_at))
        .limit(200),
    ]);

    const items: ActionHistoryItem[] = [];

    for (const r of borrowerActions) {
      items.push({
        source: "borrower_action",
        id: r.id,
        action_type: r.action_type,
        status: r.status,
        created_at: r.created_at?.toISOString() ?? null,
        payload: r.payload,
      });
    }
    for (const r of immobActions) {
      items.push({
        source: "immobilisation_action",
        id: r.id,
        action_type: "battery_immobilisation",
        status: r.executed_at ? "executed" : "pending",
        created_at: r.executed_at?.toISOString() ?? null,
        payload: {
          imei: r.imei,
          approval_request_id: r.approval_request_id,
          borrower_notified_at: r.borrower_notified_at,
        },
      });
    }
    for (const r of auditEntries) {
      const after = r.after_state as Record<string, unknown> | null;
      const before = r.before_state as Record<string, unknown> | null;
      const matchesLoan =
        (after && after.loan_sanction_id === loanSanctionId) ||
        (before && before.loan_sanction_id === loanSanctionId);
      if (!matchesLoan) continue;
      items.push({
        source: "audit_log",
        id: r.id,
        action_type: r.action_type,
        status: typeof after?.status === "string" ? after.status : null,
        created_at: r.created_at?.toISOString() ?? null,
        payload: { before_state: before, after_state: after },
      });
    }

    items.sort((a, b) => {
      const ta = a.created_at ? Date.parse(a.created_at) : 0;
      const tb = b.created_at ? Date.parse(b.created_at) : 0;
      return tb - ta;
    });

    return NextResponse.json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.includes("not allowed")
      ? 403
      : msg.startsWith("UNAUTHORIZED")
        ? 401
        : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status });
  }
}
