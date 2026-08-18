import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, otpConfirmations, productSelections } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { generateId } from "@/lib/api-utils";
import {
  productSelectionColumns,
  step5ProductSelectionSchema,
} from "@/lib/leads/productSelectionSchema";

/**
 * Step 5 product save.
 *
 * Since the Step-4/Step-5 split this is where the dealer commits to actual
 * stock. Step 4 now means "send this customer to the lenders" and carries no
 * serial and no price; the NBFC quotes against the customer's profile, and the
 * dealer picks the battery and settles the final price here, once terms are
 * known.
 *
 * It writes the same `product_selections` columns as
 * `/api/lead/[id]/submit-product-selection` — both go through
 * `productSelectionColumns()` so they can never disagree about which field
 * lands in which column.
 *
 * It deliberately does NOT reserve inventory. Reservation happens inside the
 * `confirm-dispatch` transaction, so a lead only locks stock at the moment it
 * ships. See the plan's "oversell window" note: between saving here and
 * dispatching, the serial is still available to another lead.
 *
 * Saving invalidates any outstanding OTP. The customer approves a specific
 * price over the phone, so changing the battery or the margin afterwards has
 * to force a fresh call rather than silently re-pointing an approval the
 * customer already gave.
 */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;
    const body = step5ProductSelectionSchema.parse(await req.json());

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
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
    if (lead.kyc_status !== "loan_sanctioned") {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `Product selection can only be changed while the loan is sanctioned and undispatched (current: ${lead.kyc_status})`,
          },
        },
        { status: 400 },
      );
    }

    const now = new Date();
    const columns = productSelectionColumns(body);

    const [existing] = await db
      .select({ id: productSelections.id, battery_serial: productSelections.battery_serial })
      .from(productSelections)
      .where(eq(productSelections.lead_id, leadId))
      .orderBy(desc(productSelections.created_at))
      .limit(1);

    const result = await db.transaction(async (tx) => {
      let selectionId: string;

      if (existing) {
        selectionId = existing.id;
        await tx
          .update(productSelections)
          .set({
            ...columns,
            category: body.category ?? undefined,
            model_number: body.modelNumber ?? undefined,
            updated_at: now,
          })
          .where(eq(productSelections.id, existing.id));
      } else {
        // Defensive: a sanctioned lead should always have the row Step 4
        // inserted. Create one rather than 500 so a dealer is never stranded
        // on a lead whose Step-4 row was cleaned up out from under them.
        selectionId = await generateId("PS");
        await tx.insert(productSelections).values({
          id: selectionId,
          lead_id: leadId,
          ...columns,
          category: body.category || lead.product_category_id,
          model_number: body.modelNumber || lead.product_type_id,
          payment_mode: "finance",
          admin_decision: "pending",
          submitted_by: user.id,
          submitted_at: now,
          created_at: now,
          updated_at: now,
        });
      }

      // Any OTP the customer has not yet spent approved a different number.
      // Expire it so `verify-otp` rejects it and the dealer has to re-send.
      await tx
        .update(otpConfirmations)
        .set({ expires_at: now })
        .where(
          and(
            eq(otpConfirmations.lead_id, leadId),
            eq(otpConfirmations.otp_type, "dispatch_confirmation"),
            eq(otpConfirmations.is_used, false),
          ),
        );

      return { selectionId };
    });

    return NextResponse.json({
      success: true,
      data: {
        productSelectionId: result.selectionId,
        batterySerial: body.batterySerial,
        chargerSerial: body.chargerSerial ?? null,
        finalPrice: body.finalPrice,
        // True when the dealer changed the product after an OTP was already
        // sent — the UI uses this to explain why the OTP box reset.
        otpInvalidated: !!existing && existing.battery_serial !== body.batterySerial,
      },
    });
  } catch (error) {
    console.error("[Step 5 Product Selection] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to save product selection";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 400 },
    );
  }
}
