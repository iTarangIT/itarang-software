import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { downloadDigioAuditTrail } from "@/lib/digio";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ dealerId: string }> }
) {
  try {
    const { dealerId } = await context.params;

    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const application = await db.query.dealerOnboardingApplications.findFirst({
      where: eq(dealerOnboardingApplications.id, dealerId),
    });

    if (!application) {
      return NextResponse.json(
        { error: "Dealer application not found" },
        { status: 404 }
      );
    }

    const documentId = application.providerDocumentId || null;

    if (!documentId) {
      return NextResponse.json(
        {
          error:
            "Digio document ID not found. Agreement may not be created or document id is not stored yet.",
        },
        { status: 400 }
      );
    }

    const { buffer, contentType } = await downloadDigioAuditTrail(documentId);

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="audit-trail-${dealerId}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[DIGIO_AUDIT_TRAIL_DOWNLOAD_ERROR]", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to download audit trail",
      },
      { status: 500 }
    );
  }
}