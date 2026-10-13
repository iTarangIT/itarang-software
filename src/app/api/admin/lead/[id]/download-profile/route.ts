export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { buildProfileZip, loadProfileLead } from "@/lib/lead/profile-export";
import { canOpenStoredFile, logFileOpen } from "@/lib/storage/fileAuthz";

// BRD V2 §2.6 / §3.3 — admin "Download Customer Profile".
// Streams a ZIP shaped exactly to the BRD spec:
//   customer_profile.pdf                    ← 8-section summary
//   /documents/                             ← customer KYC docs
//   /supporting_docs/                       ← Step-3 additional docs
//   /co_borrower_docs/                      ← co-borrower KYC docs
//   /product/product_selection_summary.pdf
// No DB mutation. Allowed any time after Step 4 submission. The ZIP/PDF builder
// lives in @/lib/lead/profile-export so the NBFC Acquire workspace can reuse it.

const POST_STEP_4_STATUSES = new Set([
  "pending_final_approval",
  "loan_sanctioned",
  "loan_rejected",
  "sold",
]);

export async function GET(
  req: NextRequest,
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

    const lead = await loadProfileLead(leadId);
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    // ID 166: the ZIP holds the customer's KYC files, so it follows the file
    // rule (Admin, Sales Head, CEO, or the owner of the dealer account), not
    // the wider KYC-review role set — and the download is logged as an open.
    const zipKey = `kyc/${leadId}/customer_profile.zip`;
    const { allowed, file } = await canOpenStoredFile(admin, "documents", zipKey);
    await logFileOpen({
      file,
      bucket: "documents",
      key: zipKey,
      userId: admin.id,
      role: admin.role,
      via: "session",
      allowed,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    });
    if (!allowed) {
      return NextResponse.json(
        { success: false, error: { message: "Only Admin, the Sales Head, the CEO or the account owner can download this profile." } },
        { status: 403 },
      );
    }

    if (!POST_STEP_4_STATUSES.has(lead.kyc_status ?? "")) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `Profile download is available only after Step 4 submission (current status: ${lead.kyc_status}).`,
          },
        },
        { status: 400 },
      );
    }

    const zipBuffer = await buildProfileZip(leadId, {
      generatedBy: admin.id,
      maskPii: true,
    });
    if (!zipBuffer) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="customer_profile_${leadId}.zip"`,
        "Content-Length": String(zipBuffer.byteLength),
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
