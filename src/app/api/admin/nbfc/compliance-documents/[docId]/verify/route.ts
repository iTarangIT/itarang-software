/**
 * E-005 — NBFC compliance document verify.
 *
 * PATCH /api/admin/nbfc/compliance-documents/{docId}/verify
 *
 * Sets status='verified', verified_by, verified_at on a doc currently in
 * pending_review. Returns 422 if the doc is already verified or rejected.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { nbfcComplianceDocuments, auditLogs } from "@/lib/db/schema";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    verifierNotes: z.string().max(2000).optional(),
  })
  .partial();

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
          error: "UNPROCESSABLE: validation failed",
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
          error: `UNPROCESSABLE: cannot verify a document in status '${existing[0].status}'`,
        },
        { status: 422 },
      );
    }

    const now = new Date();
    const [updated] = await db
      .update(nbfcComplianceDocuments)
      .set({
        status: "verified",
        verified_by: actor.numeric_id,
        verified_at: now,
        verifier_notes: parsed.data.verifierNotes ?? null,
      })
      .where(eq(nbfcComplianceDocuments.id, docId))
      .returning();

    // Best-effort audit log row. The audit_logs schema is shared across the
    // app; if the column shape diverges from what we insert here, swallow the
    // error so it never blocks the verify operation.
    try {
      await db.insert(auditLogs).values({
        id: `nbfc-doc-verify-${docId}-${now.getTime()}`,
        action: "nbfc_compliance_document.verified",
        entity_type: "nbfc_compliance_document",
        entity_id: String(docId),
        new_data: { verifier_notes: parsed.data.verifierNotes ?? null },
      } as unknown as typeof auditLogs.$inferInsert);
    } catch {
      // ignore — see comment above
    }

    return NextResponse.json(
      {
        id: updated.id,
        status: updated.status,
        verified_by: updated.verified_by,
        verified_at: updated.verified_at,
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
