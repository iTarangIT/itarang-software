/**
 * E-005 — NBFC compliance document reject.
 *
 * PATCH /api/admin/nbfc/compliance-documents/{docId}/reject
 *
 * Requires a non-empty rejectionReason. Sets status='rejected', rejected_by,
 * rejected_at, rejection_reason. Returns 422 if the doc isn't pending_review,
 * or if rejectionReason is empty.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { nbfcComplianceDocuments, auditLogs } from "@/lib/db/schema";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  rejectionReason: z.string().min(1).max(2000),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string }> },
) {
  try {
    const actor = await resolveAdminActor(req.headers);
    const { docId: rawDocId } = await params;
    const docId = Number.parseInt(rawDocId, 10);
    if (!Number.isFinite(docId) || docId <= 0) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid docId" },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const parsed = Body.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: "UNPROCESSABLE: rejectionReason is required",
          issues: parsed.error.issues,
        },
        { status: 422 },
      );
    }

    const existing = await db
      .select()
      .from(nbfcComplianceDocuments)
      .where(eq(nbfcComplianceDocuments.id, docId))
      .limit(1);
    if (existing.length === 0) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: document not found" },
        { status: 404 },
      );
    }
    if (existing[0].status !== "pending_review") {
      return NextResponse.json(
        {
          ok: false,
          error: `UNPROCESSABLE: cannot reject a document in status '${existing[0].status}'`,
        },
        { status: 422 },
      );
    }

    const now = new Date();
    const [updated] = await db
      .update(nbfcComplianceDocuments)
      .set({
        status: "rejected",
        rejected_by: actor.numeric_id,
        rejected_at: now,
        rejection_reason: parsed.data.rejectionReason,
      })
      .where(eq(nbfcComplianceDocuments.id, docId))
      .returning();

    try {
      await db.insert(auditLogs).values({
        id: `nbfc-doc-reject-${docId}-${now.getTime()}`,
        action: "nbfc_compliance_document.rejected",
        entity_type: "nbfc_compliance_document",
        entity_id: String(docId),
        new_data: { rejection_reason: parsed.data.rejectionReason },
      } as unknown as typeof auditLogs.$inferInsert);
    } catch {
      // ignore — best-effort audit; verify endpoint comments apply.
    }

    return NextResponse.json(
      {
        id: updated.id,
        status: updated.status,
        rejected_by: updated.rejected_by,
        rejected_at: updated.rejected_at,
        rejectionReason: updated.rejection_reason,
      },
      { status: 200 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
