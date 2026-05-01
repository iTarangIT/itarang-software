/**
 * E-001 — POST /api/admin/nbfc/{nbfcId}/approve
 *
 * Final approval gate. Server MUST re-validate the readiness conditions —
 * UI disable is advisory only. Idempotent: re-approving a row that's already
 * 'approved' or 'active' returns 409.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { nbfc, auditLogs } from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";
import { evaluateApprovalReadiness } from "@/lib/nbfc/admin/approval-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ApproveBody = z.object({
  notes: z.string().max(2000).optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ nbfcId: string }> },
) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;
  const adminUserId = auth.user.id;

  const { nbfcId } = await ctx.params;
  const id = Number.parseInt(nbfcId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { ok: false, error: "Invalid nbfcId" },
      { status: 400 },
    );
  }

  // Body — optional notes only. Tolerate empty body.
  let body: unknown = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const parsed = ApproveBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "VALIDATION", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const r = await evaluateApprovalReadiness(id);
  if (!r.exists) {
    return NextResponse.json(
      { ok: false, error: "NBFC not found" },
      { status: 404 },
    );
  }

  // Idempotency — already approved/active.
  if (r.currentStatus === "approved" || r.currentStatus === "active") {
    return NextResponse.json(
      {
        ok: false,
        error: "ALREADY_APPROVED",
        status: r.currentStatus,
      },
      { status: 409 },
    );
  }

  if (!r.canApprove) {
    return NextResponse.json(
      {
        ok: false,
        reason: r.reason,
        missingDocs: r.missingDocs,
        lspAgreementStatus: r.lspAgreementStatus,
      },
      { status: 422 },
    );
  }

  // All gates pass — flip status, stamp approver, write audit row.
  const now = new Date();
  const [updated] = await db
    .update(nbfc)
    .set({
      status: "approved",
      approved_by: adminUserId,
      approved_at: now,
      updated_at: now,
    })
    .where(eq(nbfc.id, id))
    .returning({ id: nbfc.id, status: nbfc.status, approved_at: nbfc.approved_at });

  await db.insert(auditLogs).values({
    id: randomUUID(),
    entity_type: "nbfc",
    entity_id: String(id),
    action: "nbfc.approved",
    performed_by: adminUserId,
    new_data: {
      status: "approved",
      approved_at: now.toISOString(),
      notes: parsed.data.notes ?? null,
    },
  });

  // E-002 will pick up activation (portal credentials). For now we expose the
  // approved state; the activation job can be enqueued by listening to this
  // audit row or by a follow-up call.

  return NextResponse.json({
    ok: true,
    nbfcId: updated.id,
    status: updated.status,
    approvedAt: updated.approved_at,
  });
}
