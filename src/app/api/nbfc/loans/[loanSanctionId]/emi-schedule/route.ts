/**
 * GET /api/nbfc/loans/[loanSanctionId]/emi-schedule
 *
 * Lists `emi_schedules` rows for a loan, ordered by due_date asc. Powers the
 * EMI History tab in the case-workspace drawer. Tenant-scoped through the
 * parent loan row (we resolve nbfc_loans.tenant_id first, then guard with
 * requireNbfcAccess).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { and, asc, eq } from "drizzle-orm";
import { emiSchedules, nbfcLoans } from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    const rows = await db
      .select({
        id: emiSchedules.id,
        due_date: emiSchedules.due_date,
        paid_at: emiSchedules.paid_at,
        status: emiSchedules.status,
        days_overdue: emiSchedules.days_overdue,
      })
      .from(emiSchedules)
      .where(eq(emiSchedules.loan_sanction_id, loanSanctionId))
      .orderBy(asc(emiSchedules.due_date));

    return NextResponse.json({ items: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.includes("not allowed")
      ? 403
      : msg.startsWith("UNAUTHORIZED")
        ? 401
        : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
