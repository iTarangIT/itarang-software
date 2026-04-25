import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  coBorrowers,
  kycDocuments,
  kycVerifications,
  leads,
  loanSanctions,
  otherDocumentRequests,
  productSelections,
} from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";

// BRD V2 §2.6 / §3.3 — customer profile download.
// A full ZIP with PDF + document folders is a substantial build; this first
// version returns a consolidated JSON summary so admins can review and export.
// The ZIP variant can replace the payload later without changing the route
// contract (still GET /api/admin/lead/:id/download-profile).

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireAdminAppUser();
    if (!admin) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }
    const { id: leadId } = await params;

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    const [docs, verifications, coBorrowerRows, otherDocs, selection, loan] =
      await Promise.all([
        db.select().from(kycDocuments).where(eq(kycDocuments.lead_id, leadId)),
        db.select().from(kycVerifications).where(eq(kycVerifications.lead_id, leadId)),
        db.select().from(coBorrowers).where(eq(coBorrowers.lead_id, leadId)),
        db.select().from(otherDocumentRequests).where(eq(otherDocumentRequests.lead_id, leadId)),
        db
          .select()
          .from(productSelections)
          .where(eq(productSelections.lead_id, leadId))
          .orderBy(desc(productSelections.created_at))
          .limit(1),
        db
          .select()
          .from(loanSanctions)
          .where(eq(loanSanctions.lead_id, leadId))
          .orderBy(desc(loanSanctions.created_at))
          .limit(1),
      ]);

    const body = {
      lead,
      kyc: {
        documents: docs,
        verifications,
      },
      coBorrowers: coBorrowerRows,
      supportingDocuments: otherDocs,
      productSelection: selection[0] ?? null,
      loanSanction: loan[0] ?? null,
      generatedAt: new Date().toISOString(),
      generatedBy: admin.id,
    };

    const filename = `customer_profile_${leadId}.json`;
    return new NextResponse(JSON.stringify(body, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error("[Download Profile] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to download profile";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
