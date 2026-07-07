/**
 * PATCH /api/nbfc/loans/[loanSanctionId]/tracker-override
 * DELETE /api/nbfc/loans/[loanSanctionId]/tracker-override
 *
 * Per-loan DISPLAY overrides for the EMI Tracker portfolio table. Each column
 * is nullable — a null clears that column's override (reverts to the computed
 * value). This never mutates the canonical lead / loan / schedule records; it
 * only changes what the EMI Tracker table shows. DELETE removes all overrides
 * for the loan (full reset to computed).
 *
 * PATCH body (all optional; provided keys are written, null clears):
 *   borrower, vehicleno, emi, next_due, last_paid, progress_paid,
 *   progress_total, status, dpd, mandate, next_auto_debit, financier
 *
 * Tenant-scoped through the parent loan row. Audit-logged.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { clientError } from "@/lib/nbfc/http-error";
import { nbfcAuditLog, nbfcEmiTrackerOverrides, nbfcLoans } from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { SYSTEM_USER_ID } from "@/lib/nbfc/servicing/applyEmiPayment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_STATUS = new Set(["active", "overdue", "closed"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Text fields → trimmed string or null. */
function optText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
/** Numeric fields (rupees / counts) → number or null; throws on invalid. */
function optNum(v: unknown, label: string): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`BAD_REQUEST: ${label} must be a number`);
  return n;
}
/** Date fields → 'YYYY-MM-DD' or null; throws on invalid. */
function optDate(v: unknown, label: string): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!DATE_RE.test(s) || Number.isNaN(new Date(`${s}T00:00:00.000Z`).getTime())) {
    throw new Error(`BAD_REQUEST: ${label} must be YYYY-MM-DD`);
  }
  return s;
}

async function resolveTenantLoan(loanSanctionId: string) {
  const tenant = await getCurrentTenant();
  const session = await requireNbfcAccess(tenant.id);
  const actorUserId = "id" in session ? session.id : SYSTEM_USER_ID;
  const [owner] = await db
    .select({ tenant_id: nbfcLoans.tenant_id })
    .from(nbfcLoans)
    .where(
      and(
        eq(nbfcLoans.loan_application_id, loanSanctionId),
        eq(nbfcLoans.tenant_id, tenant.id),
      ),
    )
    .limit(1);
  return { tenant, actorUserId, ownsLoan: Boolean(owner) };
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ loanSanctionId: string }> },
) {
  try {
    const { loanSanctionId } = await ctx.params;
    if (!loanSanctionId) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: loanSanctionId required" }, { status: 400 });
    }
    const { tenant, actorUserId, ownsLoan } = await resolveTenantLoan(loanSanctionId);
    if (!ownsLoan) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: loan not found for this tenant" }, { status: 404 });
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON body" }, { status: 400 });
    }

    const status = optText(body.status);
    if (status != null && !ALLOWED_STATUS.has(status)) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: status must be active|overdue|closed" }, { status: 400 });
    }

    // Build the override values. Absent keys stay null (cleared).
    const values = {
      tenant_id: tenant.id,
      loan_application_id: loanSanctionId,
      borrower: optText(body.borrower),
      vehicleno: optText(body.vehicleno),
      emi: (() => {
        const n = optNum(body.emi, "emi");
        return n == null ? null : n.toFixed(2);
      })(),
      next_due: optDate(body.next_due, "next_due"),
      last_paid: optDate(body.last_paid, "last_paid"),
      progress_paid: optNum(body.progress_paid, "progress_paid"),
      progress_total: optNum(body.progress_total, "progress_total"),
      status,
      dpd: optNum(body.dpd, "dpd"),
      mandate: optText(body.mandate),
      next_auto_debit: optDate(body.next_auto_debit, "next_auto_debit"),
      financier: optText(body.financier),
      updated_by: actorUserId,
      updated_at: new Date(),
    };

    // If every override is null, this is effectively a reset — delete the row.
    const anyOverride = [
      values.borrower, values.vehicleno, values.emi, values.next_due,
      values.last_paid, values.progress_paid, values.progress_total,
      values.status, values.dpd, values.mandate, values.next_auto_debit,
      values.financier,
    ].some((v) => v != null);

    await db.transaction(async (tx) => {
      if (!anyOverride) {
        await tx
          .delete(nbfcEmiTrackerOverrides)
          .where(
            and(
              eq(nbfcEmiTrackerOverrides.tenant_id, tenant.id),
              eq(nbfcEmiTrackerOverrides.loan_application_id, loanSanctionId),
            ),
          );
      } else {
        await tx
          .insert(nbfcEmiTrackerOverrides)
          .values(values)
          .onConflictDoUpdate({
            target: [
              nbfcEmiTrackerOverrides.tenant_id,
              nbfcEmiTrackerOverrides.loan_application_id,
            ],
            set: {
              borrower: values.borrower,
              vehicleno: values.vehicleno,
              emi: values.emi,
              next_due: values.next_due,
              last_paid: values.last_paid,
              progress_paid: values.progress_paid,
              progress_total: values.progress_total,
              status: values.status,
              dpd: values.dpd,
              mandate: values.mandate,
              next_auto_debit: values.next_auto_debit,
              financier: values.financier,
              updated_by: values.updated_by,
              updated_at: values.updated_at,
            },
          });
      }

      await tx.insert(nbfcAuditLog).values({
        tenant_id: tenant.id,
        user_id: actorUserId,
        action_type: "emi_tracker_edit",
        after_state: {
          loan_sanction_id: loanSanctionId,
          reset: !anyOverride,
          overrides: {
            borrower: values.borrower,
            vehicleno: values.vehicleno,
            emi: values.emi,
            next_due: values.next_due,
            last_paid: values.last_paid,
            progress_paid: values.progress_paid,
            progress_total: values.progress_total,
            status: values.status,
            dpd: values.dpd,
            mandate: values.mandate,
            next_auto_debit: values.next_auto_debit,
            financier: values.financier,
          },
        },
      });
    });

    return NextResponse.json({ ok: true, reset: !anyOverride });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("BAD_REQUEST")
      ? 400
      : msg.includes("FORBIDDEN") || msg.includes("not allowed")
        ? 403
        : msg.startsWith("UNAUTHORIZED")
          ? 401
          : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status });
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ loanSanctionId: string }> },
) {
  try {
    const { loanSanctionId } = await ctx.params;
    if (!loanSanctionId) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: loanSanctionId required" }, { status: 400 });
    }
    const { tenant, actorUserId, ownsLoan } = await resolveTenantLoan(loanSanctionId);
    if (!ownsLoan) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: loan not found for this tenant" }, { status: 404 });
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(nbfcEmiTrackerOverrides)
        .where(
          and(
            eq(nbfcEmiTrackerOverrides.tenant_id, tenant.id),
            eq(nbfcEmiTrackerOverrides.loan_application_id, loanSanctionId),
          ),
        );
      await tx.insert(nbfcAuditLog).values({
        tenant_id: tenant.id,
        user_id: actorUserId,
        action_type: "emi_tracker_edit",
        after_state: { loan_sanction_id: loanSanctionId, reset: true },
      });
    });

    return NextResponse.json({ ok: true, reset: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.includes("FORBIDDEN") || msg.includes("not allowed")
      ? 403
      : msg.startsWith("UNAUTHORIZED")
        ? 401
        : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status });
  }
}
