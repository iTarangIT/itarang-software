/**
 * POST /api/admin/nbfc-requests/[id]/forward
 *
 * Admin reviews an NBFC request and EITHER forwards it to the dealer (creating
 * the otherDocumentRequests children — reuses the step3 insert shape) OR
 * declines it (Change 2, hop 3 / R). Body:
 *   { action: 'forward', items: [{doc_label, doc_key?, is_required?, reason?}], adminNotes? }
 *   { action: 'decline', adminNotes? }
 *
 * Auth: requireAdminAppUser().
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { nbfcDocRequests } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import {
  declineNbfcDocRequest,
  forwardNbfcDocRequest,
} from "@/lib/nbfc/doc-requests";
import { notifyDealerForLead } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ItemSchema = z.object({
  doc_label: z.string().min(1),
  doc_key: z.string().min(1).optional(),
  is_required: z.boolean().default(true),
  reason: z.string().optional(),
});

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("forward"),
    items: z.array(ItemSchema).min(1),
    adminNotes: z.string().max(4000).optional().nullable(),
  }),
  z.object({
    action: z.literal("decline"),
    adminNotes: z.string().max(4000).optional().nullable(),
  }),
]);

function statusFromError(msg: string): number {
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }
    const { id } = await params;
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { message: "Validation failed", details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    const [wrapper] = await db
      .select({ id: nbfcDocRequests.id, lead_id: nbfcDocRequests.lead_id })
      .from(nbfcDocRequests)
      .where(eq(nbfcDocRequests.id, id))
      .limit(1);
    if (!wrapper) {
      return NextResponse.json(
        { success: false, error: { message: "NBFC request not found" } },
        { status: 404 },
      );
    }

    if (parsed.data.action === "decline") {
      await declineNbfcDocRequest({
        requestId: id,
        adminUserId: appUser.id,
        adminNotes: parsed.data.adminNotes ?? null,
      });
      return NextResponse.json({ success: true, data: { status: "rejected" } });
    }

    const result = await forwardNbfcDocRequest({
      requestId: id,
      adminUserId: appUser.id,
      items: parsed.data.items,
      adminNotes: parsed.data.adminNotes ?? null,
    });

    // Best-effort: nudge the dealer that Step-3 documents are required. The
    // data.href deep-links the bell to Step 3's Additional Documents section.
    await notifyDealerForLead({
      leadId: wrapper.lead_id,
      type: "nbfc_doc_request_forwarded",
      title: `${result.requests.length} document(s) requested`,
      message: `iTarang admin (NBFC request) — please collect and upload ${result.requests.length} document(s) on Step 3.`,
      data: {
        requestId: id,
        count: result.requests.length,
        step: 3,
        href: `/dealer-portal/leads/${wrapper.lead_id}/borrower-consent#other-documentation`,
      },
    }).catch(() => {});

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to forward request";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: statusFromError(message) },
    );
  }
}
