import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { InventoryLifecycleError } from "@/lib/inventory/lifecycle";
import { DispatchError, confirmDispatch } from "@/lib/leads/confirm-dispatch";

// BRD V2 §3.3 — Step 5 OTP validation + dispatch confirmation.
//
// The transaction lives in `src/lib/leads/confirm-dispatch.ts`: the customer can
// confirm the same dispatch from their WhatsApp chat, and this is the one step
// of the journey where a second implementation would move stock and money
// twice. This route keeps auth, ownership and HTTP shaping.

const BodySchema = z.object({
  otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;
    const { otp } = BodySchema.parse(await req.json());

    const [lead] = await db
      .select({ id: leads.id, dealer_id: leads.dealer_id })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }

    const result = await confirmDispatch({
      leadId,
      otp,
      performedBy: user.id,
      dealerId: user.dealer_id!,
    });

    return NextResponse.json({
      success: true,
      data: {
        leadStatus: result.leadStatus,
        warrantyId: result.warrantyId,
        warrantyStart: result.warrantyStart.toISOString(),
        warrantyEnd: result.warrantyEnd.toISOString(),
        afterSalesId: result.afterSalesId,
        // The value actually written to loan_sanctions.status. This field used
        // to report the legacy 'dealer_approved' while the row was set to
        // 'disbursed' — nothing consumed it, so it was corrected rather than
        // kept lying.
        loanStatus: result.loanStatus,
        message:
          "Dispatch confirmed. Inventory dispatched. Warranty activated. Lead will auto-finalize on delivery (or click Mark Delivered when handed over).",
      },
    });
  } catch (error) {
    console.error("[Step 5 Confirm Dispatch] Error:", error);
    // The serial was taken by another lead between the dealer's Step-5 save and
    // this confirm. Surface the lifecycle message and its own status (409) so
    // the dealer is told to pick different stock rather than seeing a generic
    // dispatch failure.
    if (error instanceof InventoryLifecycleError) {
      return NextResponse.json(
        { success: false, error: { message: error.message } },
        { status: error.statusCode },
      );
    }
    if (error instanceof DispatchError) {
      return NextResponse.json(
        { success: false, error: { message: error.message } },
        { status: error.status },
      );
    }
    const message = error instanceof Error ? error.message : "Failed to confirm dispatch";
    // E-101: bad payment_method on the lead is a client-mappable input error,
    // not a server crash. Surface it as 400 so the dealer can be told to fix the
    // lead before retrying dispatch.
    const status =
      error instanceof Error && error.name === "PaymentModeMappingError" ? 400 : 500;
    return NextResponse.json(
      { success: false, error: { message } },
      { status },
    );
  }
}
