import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { inventory, leads, productSelections } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { generateId } from "@/lib/api-utils";
import { finalizeSale } from "@/lib/sales/sale-finalization";
import { notifyProductSelectionSubmitted } from "@/lib/notifications";

// BRD V2 §2.5 — cash path confirmation for Step 4.
// No admin approval step. All writes (product_selection + inventory + warranty
// + after-sales) execute in a single transaction.

const ParaLineSchema = z.object({
  asset_type: z.string(),
  model_type: z.string().nullable().optional(),
  product_name: z.string().nullable().optional(),
  product_id: z.string().nullable().optional(),
  qty: z.number().min(0),
  unit_gross: z.number().min(0),
  gst_percent: z.number().min(0),
  gst_amount: z.number().min(0),
  unit_net: z.number().min(0),
  line_gross: z.number().min(0),
  line_gst: z.number().min(0),
  line_net: z.number().min(0),
});

const BodySchema = z.object({
  batterySerial: z.string().min(1),
  chargerSerial: z.string().min(1),
  paraphernalia: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  paraphernaliaLines: z.array(ParaLineSchema).optional(),
  dealerMargin: z.number().min(0),
  finalPrice: z.number().min(0),
  batteryPrice: z.number().min(0).optional(),
  chargerPrice: z.number().min(0).optional(),
  paraphernaliaCost: z.number().min(0).optional(),
  batteryGross: z.number().min(0).optional(),
  batteryGstPercent: z.number().min(0).optional(),
  batteryGstAmount: z.number().min(0).optional(),
  batteryNet: z.number().min(0).optional(),
  chargerGross: z.number().min(0).optional(),
  chargerGstPercent: z.number().min(0).optional(),
  chargerGstAmount: z.number().min(0).optional(),
  chargerNet: z.number().min(0).optional(),
  grossSubtotal: z.number().min(0).optional(),
  gstSubtotal: z.number().min(0).optional(),
  netSubtotal: z.number().min(0).optional(),
  category: z.string().optional(),
  subCategory: z.string().optional(),
});

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
    if (paymentMode !== "cash") {
      return NextResponse.json(
        { success: false, error: { message: "Not a cash lead — use submit-product-selection for finance" } },
        { status: 400 },
      );
    }

    const productSelectionId = await generateId("PS");
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      // 1. Race-condition guards on inventory
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

      // 2. Product selection — dealer_confirmed immediately (no admin step)
      await tx.insert(productSelections).values({
        id: productSelectionId,
        lead_id: leadId,
        battery_serial: body.batterySerial,
        charger_serial: body.chargerSerial,
        paraphernalia: body.paraphernalia ?? {},
        paraphernalia_lines: body.paraphernaliaLines ?? [],
        category: body.category || lead.product_category_id,
        sub_category: body.subCategory || lead.product_type_id,
        battery_price: body.batteryPrice?.toString(),
        charger_price: body.chargerPrice?.toString(),
        paraphernalia_cost: body.paraphernaliaCost?.toString(),
        dealer_margin: body.dealerMargin.toString(),
        final_price: body.finalPrice.toString(),
        battery_gross: body.batteryGross?.toString(),
        battery_gst_percent: body.batteryGstPercent?.toString(),
        battery_gst_amount: body.batteryGstAmount?.toString(),
        battery_net: body.batteryNet?.toString(),
        charger_gross: body.chargerGross?.toString(),
        charger_gst_percent: body.chargerGstPercent?.toString(),
        charger_gst_amount: body.chargerGstAmount?.toString(),
        charger_net: body.chargerNet?.toString(),
        gross_subtotal: body.grossSubtotal?.toString(),
        gst_subtotal: body.gstSubtotal?.toString(),
        net_subtotal: body.netSubtotal?.toString(),
        payment_mode: "cash",
        admin_decision: "dealer_confirmed",
        submitted_by: user.id,
        submitted_at: now,
        created_at: now,
        updated_at: now,
      });

      // 3. Finalize sale: inventory sold + warranty + after-sales
      const sale = await finalizeSale({
        tx,
        leadId,
        batterySerial: body.batterySerial,
        chargerSerial: body.chargerSerial,
        dealerId: user.dealer_id!,
        customerName: lead.full_name || lead.owner_name || null,
        customerPhone: lead.phone || lead.mobile || null,
        paymentMode: "cash",
        performedBy: user.id,
        soldAt: now,
      });

      // 4. Close lead
      await tx
        .update(leads)
        .set({ kyc_status: "sold", sold_at: now, updated_at: now })
        .where(eq(leads.id, leadId));

      return sale;
    });

    notifyProductSelectionSubmitted({
      leadId,
      productSelectionId,
      paymentMode: "cash",
      finalPrice: body.finalPrice,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: {
        leadStatus: "sold",
        productSelectionId,
        warrantyId: result.warrantyId,
        warrantyStart: result.warrantyStart.toISOString(),
        warrantyEnd: result.warrantyEnd.toISOString(),
        afterSalesId: result.afterSalesId,
        message: "Sale confirmed. Inventory sold. Warranty activated.",
      },
    });
  } catch (error) {
    console.error("[Confirm Cash Sale] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to confirm sale";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 400 },
    );
  }
}
