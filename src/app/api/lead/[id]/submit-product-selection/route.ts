import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { inventory, leads, productSelections } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { generateId } from "@/lib/api-utils";
import { notifyProductSelectionSubmitted } from "@/lib/notifications";

// BRD V2 §2.4 — finance path submit for Step 4.
// Reserves battery + charger inventory, stores product selection, advances
// lead to 'pending_final_approval' and routes to admin queue.

const BodySchema = z.object({
  batterySerial: z.string().min(1),
  chargerSerial: z.string().min(1),
  paraphernalia: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  dealerMargin: z.number().min(0),
  finalPrice: z.number().min(0),
  batteryPrice: z.number().min(0).optional(),
  chargerPrice: z.number().min(0).optional(),
  paraphernaliaCost: z.number().min(0).optional(),
  category: z.string().optional(),
  subCategory: z.string().optional(),
});

const FINANCE_UNLOCKED = new Set(["step_3_cleared", "kyc_approved"]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;
    const body = BodySchema.parse(await req.json());

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

    const paymentMode = String(lead.payment_method || "").toLowerCase();
    if (paymentMode === "cash") {
      return NextResponse.json(
        { success: false, error: { message: "Use confirm-cash-sale for cash leads" } },
        { status: 400 },
      );
    }
    if (!FINANCE_UNLOCKED.has(String(lead.kyc_status))) {
      return NextResponse.json(
        { success: false, error: { message: `Lead not eligible for Step 4 (kyc_status=${lead.kyc_status})` } },
        { status: 400 },
      );
    }

    const productSelectionId = await generateId("PS");
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      // Race-condition guard: battery must be available + belong to this dealer.
      const [battery] = await tx
        .select()
        .from(inventory)
        .where(
          and(
            eq(inventory.serial_number, body.batterySerial),
            eq(inventory.dealer_id, user.dealer_id!),
          ),
        )
        .limit(1);
      if (!battery || battery.status !== "available") {
        throw new Error(`Battery ${body.batterySerial} is not available`);
      }

      const [charger] = await tx
        .select()
        .from(inventory)
        .where(
          and(
            eq(inventory.serial_number, body.chargerSerial),
            eq(inventory.dealer_id, user.dealer_id!),
          ),
        )
        .limit(1);
      if (!charger || charger.status !== "available") {
        throw new Error(`Charger ${body.chargerSerial} is not available`);
      }

      // Insert product selection
      await tx.insert(productSelections).values({
        id: productSelectionId,
        lead_id: leadId,
        battery_serial: body.batterySerial,
        charger_serial: body.chargerSerial,
        paraphernalia: body.paraphernalia ?? {},
        category: body.category || lead.product_category_id,
        sub_category: body.subCategory || lead.product_type_id,
        battery_price: body.batteryPrice?.toString(),
        charger_price: body.chargerPrice?.toString(),
        paraphernalia_cost: body.paraphernaliaCost?.toString(),
        dealer_margin: body.dealerMargin.toString(),
        final_price: body.finalPrice.toString(),
        payment_mode: "finance",
        admin_decision: "pending",
        submitted_by: user.id,
        submitted_at: now,
        created_at: now,
        updated_at: now,
      });

      // Reserve inventory
      await tx
        .update(inventory)
        .set({ status: "reserved", linked_lead_id: leadId, updated_at: now })
        .where(eq(inventory.id, battery.id));
      await tx
        .update(inventory)
        .set({ status: "reserved", linked_lead_id: leadId, updated_at: now })
        .where(eq(inventory.id, charger.id));

      // Advance lead
      await tx
        .update(leads)
        .set({ kyc_status: "pending_final_approval", updated_at: now })
        .where(eq(leads.id, leadId));

      return { productSelectionId };
    });

    notifyProductSelectionSubmitted({
      leadId,
      productSelectionId: result.productSelectionId,
      paymentMode: "finance",
      finalPrice: body.finalPrice,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: {
        leadStatus: "pending_final_approval",
        productSelectionId: result.productSelectionId,
        inventoryLocked: {
          battery: body.batterySerial,
          charger: body.chargerSerial,
        },
      },
    });
  } catch (error) {
    console.error("[Submit Product Selection] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to submit";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 400 },
    );
  }
}
