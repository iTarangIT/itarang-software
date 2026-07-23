/**
 * POST /api/admin/nbfc-requests/verdicts/[verdictId]/forward
 *
 * Admin forwards a single NBFC per-document verdict (nbfc_document_verifications,
 * E-201) to the dealer as a re-upload request (E-209). Only a 'queried'
 * (correction requested) or 'rejected' verdict can be forwarded. The child
 * document request lands on:
 *   • the dealer's Step 2 (customer KYC)     when doc_for = 'primary'
 *   • the dealer's Step 3 (co-borrower docs) when doc_for = 'co_borrower'
 *
 * Body: { message } — the admin's instruction to the dealer, required; it
 * travels with the request as the re-upload reason. Auth: requireAdminAppUser().
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { forwardVerdictToDealer } from "@/lib/nbfc/doc-requests";
import { notifyDealerForLead } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  message: z.string().trim().min(1).max(4000),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ verdictId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { verdictId } = await params;
    const id = Number(verdictId);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json(
        { success: false, error: { message: "Invalid verdict id" } },
        { status: 400 },
      );
    }

    const parsed = Body.safeParse(await _req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "A message for the dealer is required" },
        },
        { status: 400 },
      );
    }

    const result = await forwardVerdictToDealer({
      verdictId: id,
      adminUserId: appUser.id,
      message: parsed.data.message,
    });

    // Best-effort: nudge the dealer that a document is required. The explicit
    // data.href deep-links the bell straight to the right step + the Additional
    // Documents section on the dealer portal (the bell prioritises data.href).
    const where =
      result.step === 3
        ? "Step 3 (co-borrower documents)"
        : "Step 2 (customer documents)";
    const href =
      result.step === 3
        ? `/dealer-portal/leads/${result.leadId}/borrower-consent#other-documentation`
        : `/dealer-portal/leads/${result.leadId}/kyc#other-documentation`;
    await notifyDealerForLead({
      leadId: result.leadId,
      type: "nbfc_verdict_forwarded",
      title: `Re-upload requested: ${result.docLabel}`,
      message: `iTarang admin (NBFC request) — the ${result.docFor === "co_borrower" ? "co-borrower's" : "customer's"} ${result.docLabel} needs re-upload on ${where}. "${parsed.data.message}"`,
      data: {
        requestId: result.requestId,
        step: result.step,
        note: parsed.data.message,
        href,
      },
    }).catch(() => {});

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to forward verdict";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: statusFromError(message) },
    );
  }
}
