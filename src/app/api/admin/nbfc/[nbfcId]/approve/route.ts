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
import { triggerLspSigning } from "@/lib/nbfc/admin/lsp-agreement-trigger";

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

  // CEO-only gate. The /nbfc-onboarding headed test exercises the full flow
  // through `via: "test_bypass"` and skips the CEO check; in production every
  // session-authenticated caller must be CEO Sanchit (or a user explicitly
  // carrying role='ceo').
  if (auth.user.via !== "test_bypass") {
    const role = auth.user.role ?? "";
    const email = (auth.user.email ?? "").toLowerCase();
    const isCeo = role === "ceo" || email === "sanchit@itarang.com";
    if (!isCeo) {
      return NextResponse.json(
        {
          ok: false,
          error: "FORBIDDEN: only the CEO can approve NBFC onboarding",
        },
        { status: 403 },
      );
    }
  }

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
        missingEntityKyc: r.missingEntityKyc,
        missingDirectorKyc: r.missingDirectorKyc,
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

  // E-112 — if the agreement is sitting in PENDING_CEO_VERIFICATION, the CEO's
  // approve click is what fires Digio. We do this synchronously so any Digio
  // 4xx is surfaced back to the CEO UI; the NBFC stays `approved` regardless
  // (the admin can hit the resend endpoint to retry). When the agreement is
  // already COMPLETED, the webhook path owns activation — skip.
  let digioTriggered: { documentId: string; signerCount: number } | null = null;
  let digioError: string | null = null;
  if (r.lspAgreementStatus === "PENDING_CEO_VERIFICATION") {
    try {
      const out = await triggerLspSigning(id);
      digioTriggered = {
        documentId: out.digioDocumentId,
        signerCount: out.signerCount,
      };
      await db.insert(auditLogs).values({
        id: randomUUID(),
        entity_type: "nbfc",
        entity_id: String(id),
        action: "nbfc.lsp_agreement.digio_triggered",
        performed_by: adminUserId,
        new_data: {
          digio_document_id: out.digioDocumentId,
          signer_count: out.signerCount,
        },
      });
    } catch (err) {
      digioError = err instanceof Error ? err.message : String(err);
      console.error(
        "[nbfc.approve] Digio trigger failed — NBFC stays approved, admin can resend",
        digioError,
      );
      await db.insert(auditLogs).values({
        id: randomUUID(),
        entity_type: "nbfc",
        entity_id: String(id),
        action: "nbfc.lsp_agreement.digio_trigger_failed",
        performed_by: adminUserId,
        new_data: { error: digioError },
      });
    }
  }

  return NextResponse.json({
    ok: true,
    nbfcId: updated.id,
    status: updated.status,
    approvedAt: updated.approved_at,
    digio: digioTriggered,
    digioError,
  });
}
