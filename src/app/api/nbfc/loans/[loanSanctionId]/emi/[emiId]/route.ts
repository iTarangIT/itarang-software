/**
 * PATCH /api/nbfc/loans/[loanSanctionId]/emi/[emiId]
 *
 * Manual override of an EMI installment's details from the EMI Tracker drawer.
 * Lets an NBFC operator correct any of: due date, amount, status, and the
 * cleared/paid date. This is a data-correction tool — it edits the
 * `emi_schedules` row and writes an immutable nbfc_audit_log entry. It does NOT
 * re-run settlement (outstanding balance / loan-close), which stays owned by the
 * record-payment / auto-debit path; large corrections should be reconciled there.
 *
 * Accepts JSON (all fields optional; at least one required):
 *   due_date  ('YYYY-MM-DD')
 *   amount    (rupees, >= 0)
 *   status    (scheduled | overdue | missed | paid | paid_late | failed)
 *   paid_at   ('YYYY-MM-DD' | null)  — cleared date; auto-cleared when status
 *                                      moves to a non-settled state.
 *
 * Tenant-scoped through the parent loan row.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { clientError } from "@/lib/nbfc/http-error";
import { emiSchedules, nbfcAuditLog, nbfcLoans } from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { SYSTEM_USER_ID } from "@/lib/nbfc/servicing/applyEmiPayment";
import { recomputeLoanDpd } from "@/lib/nbfc/servicing/recomputeLoanDpd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_STATUS = new Set([
  "scheduled",
  "overdue",
  "missed",
  "paid",
  "paid_late",
  "failed",
]);
const SETTLED = new Set(["paid", "paid_late"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days between two dates (b - a), floored. */
function dayDiff(a: Date, b: Date): number {
  const aMid = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const bMid = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.floor((bMid - aMid) / 86_400_000);
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ loanSanctionId: string; emiId: string }> },
) {
  try {
    const tenant = await getCurrentTenant();
    const session = await requireNbfcAccess(tenant.id);
    const actorUserId = "id" in session ? session.id : SYSTEM_USER_ID;

    const { loanSanctionId, emiId } = await ctx.params;
    if (!loanSanctionId || !emiId) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: loanSanctionId and emiId required" },
        { status: 400 },
      );
    }

    // Tenant ownership of the loan.
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
    if (!owner) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: loan not found for this tenant" },
        { status: 404 },
      );
    }

    // The EMI must belong to that loan.
    const [emi] = await db
      .select({
        id: emiSchedules.id,
        emi_seq: emiSchedules.emi_seq,
        due_date: emiSchedules.due_date,
        paid_at: emiSchedules.paid_at,
        status: emiSchedules.status,
        days_overdue: emiSchedules.days_overdue,
        amount: emiSchedules.amount,
        amount_paid: emiSchedules.amount_paid,
      })
      .from(emiSchedules)
      .where(and(eq(emiSchedules.id, emiId), eq(emiSchedules.loan_sanction_id, loanSanctionId)))
      .limit(1);
    if (!emi) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: EMI not found for this loan" },
        { status: 404 },
      );
    }

    // ---- Parse & validate body ----------------------------------------------
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON body" }, { status: 400 });
    }

    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

    // due_date
    let dueDate = emi.due_date; // 'YYYY-MM-DD'
    if (has("due_date")) {
      const d = String(body.due_date ?? "").trim();
      if (!DATE_RE.test(d) || Number.isNaN(new Date(`${d}T00:00:00.000Z`).getTime())) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: due_date must be YYYY-MM-DD" }, { status: 400 });
      }
      dueDate = d;
    }

    // amount
    let amount = emi.amount; // string | null
    if (has("amount")) {
      const n = Number(body.amount);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: amount must be >= 0" }, { status: 400 });
      }
      amount = n.toFixed(2);
    }

    // status
    let status = emi.status;
    if (has("status")) {
      const s = String(body.status ?? "").trim();
      if (!ALLOWED_STATUS.has(s)) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid status" }, { status: 400 });
      }
      status = s;
    }

    // paid_at — explicit value wins; otherwise derived from the status change.
    let paidAt: Date | null = emi.paid_at ? new Date(emi.paid_at) : null;
    if (has("paid_at")) {
      const raw = body.paid_at;
      if (raw === null || raw === "") {
        paidAt = null;
      } else {
        const d = String(raw).trim();
        if (!DATE_RE.test(d) || Number.isNaN(new Date(`${d}T00:00:00.000Z`).getTime())) {
          return NextResponse.json({ ok: false, error: "BAD_REQUEST: paid_at must be YYYY-MM-DD or null" }, { status: 400 });
        }
        paidAt = new Date(`${d}T00:00:00.000Z`);
      }
    }
    // Keep paid_at consistent with status: settled needs a date (default today),
    // non-settled clears it.
    if (SETTLED.has(status)) {
      if (!paidAt) paidAt = new Date();
    } else {
      paidAt = null;
    }

    // Recompute days_overdue from the (possibly new) due date.
    const dueMid = new Date(`${dueDate}T00:00:00.000Z`);
    const daysOverdue = SETTLED.has(status)
      ? Math.max(0, dayDiff(dueMid, paidAt ?? new Date()))
      : Math.max(0, dayDiff(dueMid, new Date()));

    // A settled EMI's paid vs paid_late is DERIVED from lateness (paid_at vs
    // due_date), never taken from the dropdown as-is — otherwise an EMI cleared
    // after its due date could be saved as a green on-time "Paid" while
    // days_overdue says 128, and the two columns would contradict. Mirrors
    // applyEmiPayment's settle logic.
    if (SETTLED.has(status)) {
      status = daysOverdue > 0 ? "paid_late" : "paid";
    }

    if (
      dueDate === emi.due_date &&
      amount === emi.amount &&
      status === emi.status &&
      (paidAt?.getTime() ?? null) === (emi.paid_at ? new Date(emi.paid_at).getTime() : null)
    ) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no changes supplied" }, { status: 400 });
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(emiSchedules)
        .set({
          due_date: dueDate,
          amount,
          status,
          paid_at: paidAt,
          days_overdue: daysOverdue,
        })
        .where(eq(emiSchedules.id, emi.id))
        .returning({
          id: emiSchedules.id,
          emi_seq: emiSchedules.emi_seq,
          due_date: emiSchedules.due_date,
          paid_at: emiSchedules.paid_at,
          status: emiSchedules.status,
          days_overdue: emiSchedules.days_overdue,
          amount: emiSchedules.amount,
          amount_paid: emiSchedules.amount_paid,
        });

      // Re-derive the loan's stored current_dpd from the (now-edited)
      // emi_schedules window so the DPD column + DPD-based status/filters on the
      // EMI Tracker, Lead Intelligence and Battery Monitoring track this edit
      // immediately instead of lagging until the nightly aging sweep.
      await recomputeLoanDpd(tx, loanSanctionId);

      await tx.insert(nbfcAuditLog).values({
        tenant_id: tenant.id,
        user_id: actorUserId,
        action_type: "emi_edit",
        action_id: emi.id,
        before_state: {
          emi_schedule_id: emi.id,
          loan_sanction_id: loanSanctionId,
          due_date: emi.due_date,
          amount: emi.amount,
          status: emi.status,
          paid_at: emi.paid_at,
          days_overdue: emi.days_overdue,
        },
        after_state: {
          emi_schedule_id: emi.id,
          loan_sanction_id: loanSanctionId,
          due_date: dueDate,
          amount,
          status,
          paid_at: paidAt,
          days_overdue: daysOverdue,
        },
      });

      return row;
    });

    return NextResponse.json({ ok: true, item: updated });
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
