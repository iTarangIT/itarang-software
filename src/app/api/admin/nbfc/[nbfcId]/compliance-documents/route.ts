/**
 * E-005 — NBFC compliance document upload.
 *
 * POST /api/admin/nbfc/{nbfcId}/compliance-documents
 *
 * Inserts a row into nbfc_compliance_documents with status='pending_review'.
 * For document_type='rbi_cor', expiry_date is required and is mirrored onto
 * nbfc.cor_expiry_date.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { nbfc, nbfcComplianceDocuments } from "@/lib/db/schema";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOCUMENT_TYPES = [
  "rbi_cor",
  "certificate_of_incorporation",
  "pan_card_company",
  "gst_registration",
  "audited_financials",
  "board_resolution",
  "fair_practices_code",
  "kyc_policy",
  "lsp_agreement_executed",
  "nach_mandate_template",
  "recovery_immobilisation_sop",
] as const;

const Body = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  fileUrl: z.string().url(),
  expiryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ nbfcId: string }> },
) {
  try {
    const actor = await resolveAdminActor(req.headers);
    const { nbfcId: rawNbfcId } = await params;
    const nbfcIdNum = Number.parseInt(rawNbfcId, 10);
    if (!Number.isFinite(nbfcIdNum) || nbfcIdNum <= 0) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid nbfcId" },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = Body.safeParse(body);
    if (!parsed.success) {
      // Per BRD: "uploads with unknown document_type return 422" and
      // missing required fields are also unprocessable rather than malformed.
      return NextResponse.json(
        {
          ok: false,
          error: "UNPROCESSABLE: validation failed",
          issues: parsed.error.issues,
        },
        { status: 422 },
      );
    }

    if (parsed.data.documentType === "rbi_cor" && !parsed.data.expiryDate) {
      return NextResponse.json(
        {
          ok: false,
          error: "UNPROCESSABLE: expiryDate is required for rbi_cor documents",
        },
        { status: 422 },
      );
    }

    const targetNbfc = await db
      .select({ id: nbfc.id })
      .from(nbfc)
      .where(eq(nbfc.id, nbfcIdNum))
      .limit(1);
    if (targetNbfc.length === 0) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: nbfc not found" },
        { status: 404 },
      );
    }

    const [inserted] = await db
      .insert(nbfcComplianceDocuments)
      .values({
        nbfc_id: nbfcIdNum,
        document_type: parsed.data.documentType,
        file_url: parsed.data.fileUrl,
        expiry_date: parsed.data.expiryDate ?? null,
        status: "pending_review",
        uploaded_by: actor.numeric_id,
      })
      .returning();

    // RBI CoR: mirror expiry_date onto nbfc.cor_expiry_date so downstream
    // alerting (E-006) can read from the master row.
    if (parsed.data.documentType === "rbi_cor" && parsed.data.expiryDate) {
      await db
        .update(nbfc)
        .set({ cor_expiry_date: parsed.data.expiryDate })
        .where(eq(nbfc.id, nbfcIdNum));
    }

    return NextResponse.json(
      {
        id: inserted.id,
        status: inserted.status,
        document_type: inserted.document_type,
        nbfc_id: inserted.nbfc_id,
        file_url: inserted.file_url,
        expiry_date: inserted.expiry_date,
        created_at: inserted.created_at,
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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ nbfcId: string }> },
) {
  try {
    await resolveAdminActor(req.headers);
    const { nbfcId: rawNbfcId } = await params;
    const nbfcIdNum = Number.parseInt(rawNbfcId, 10);
    if (!Number.isFinite(nbfcIdNum) || nbfcIdNum <= 0) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid nbfcId" },
        { status: 400 },
      );
    }
    const rows = await db
      .select()
      .from(nbfcComplianceDocuments)
      .where(eq(nbfcComplianceDocuments.nbfc_id, nbfcIdNum));
    return NextResponse.json({ items: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
