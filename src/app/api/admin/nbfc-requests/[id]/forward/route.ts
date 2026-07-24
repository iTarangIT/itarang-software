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
import { notifyNbfcRequestForwarded } from "@/lib/notifications/events";

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

    // Nudge the dealer that documents are required, naming them so they know
    // what to collect without opening the lead first. The href deep-links to
    // Step 3's Additional Documents section.
    await notifyNbfcRequestForwarded({
      leadId: wrapper.lead_id,
      requestId: id,
      docLabels: parsed.data.items.map((i) => i.doc_label).filter(Boolean),
      targetStep: "borrower-consent",
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to forward request";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: statusFromError(message) },
    );
  }
}
