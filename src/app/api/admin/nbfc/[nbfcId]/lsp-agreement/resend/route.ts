/**
 * E-112 — POST /api/admin/nbfc/{nbfcId}/lsp-agreement/resend
 *
 * Re-fires the Digio multi-template sign request when the initial CEO-approve
 * trigger failed (Digio outage, transient 5xx) or the agreement has expired
 * and the admin wants fresh signing emails sent out. Idempotent on the
 * agreement row — calling it after the bundle is already SENT/SIGNED/COMPLETED
 * returns the existing digio_document_id without re-firing.
 *
 * Admin-or-CEO authorized; we don't gate by NBFC status here because the only
 * legitimate caller is an admin/CEO unblocking a stuck signing flow.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, nbfc, nbfcLspAgreements } from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";
import {
  resetExpiredSignersToSent,
  triggerLspSigning,
} from "@/lib/nbfc/admin/lsp-agreement-trigger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const [nbfcRow] = await db
    .select({ id: nbfc.id, status: nbfc.status })
    .from(nbfc)
    .where(eq(nbfc.id, id))
    .limit(1);
  if (!nbfcRow) {
    return NextResponse.json(
      { ok: false, error: "NBFC not found" },
      { status: 404 },
    );
  }

  const [agreement] = await db
    .select({ id: nbfcLspAgreements.id, agreement_status: nbfcLspAgreements.agreement_status })
    .from(nbfcLspAgreements)
    .where(eq(nbfcLspAgreements.nbfc_id, id))
    .orderBy(nbfcLspAgreements.id)
    .limit(1);
  if (!agreement) {
    return NextResponse.json(
      { ok: false, error: "No LSP agreement on file" },
      { status: 404 },
    );
  }

  // If the agreement expired or any signer is in 'expired' state, reset those
  // rows back to 'sent' so the post-trigger UI doesn't render stale red pills.
  if (
    agreement.agreement_status === "EXPIRED" ||
    agreement.agreement_status === "FAILED"
  ) {
    // Treat as fresh trigger — clear the SENT/SIGNED idempotency check by
    // wiping the digio_document_id so triggerLspSigning re-fires.
    await db
      .update(nbfcLspAgreements)
      .set({
        digio_document_id: null,
        digio_request_id: null,
        agreement_status: "PENDING_CEO_VERIFICATION",
        updated_at: new Date(),
      })
      .where(eq(nbfcLspAgreements.id, agreement.id));
  }
  await resetExpiredSignersToSent(agreement.id);

  try {
    const out = await triggerLspSigning(id);
    await db.insert(auditLogs).values({
      id: randomUUID(),
      entity_type: "nbfc",
      entity_id: String(id),
      action: "nbfc.lsp_agreement.digio_resent",
      performed_by: adminUserId,
      new_data: {
        digio_document_id: out.digioDocumentId,
        signer_count: out.signerCount,
      },
    });
    return NextResponse.json({
      ok: true,
      digio: {
        documentId: out.digioDocumentId,
        signerCount: out.signerCount,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[nbfc.lsp_agreement.resend] Digio trigger failed", message);
    await db.insert(auditLogs).values({
      id: randomUUID(),
      entity_type: "nbfc",
      entity_id: String(id),
      action: "nbfc.lsp_agreement.digio_resend_failed",
      performed_by: adminUserId,
      new_data: { error: message },
    });
    return NextResponse.json(
      { ok: false, error: "DIGIO_FAILED", message },
      { status: 502 },
    );
  }
}
