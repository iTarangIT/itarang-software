import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { storedFileUrl } from "@/lib/api-utils";
import { CashSaleError, confirmCashSale } from "@/lib/leads/confirm-cash-sale";

// BRD V2 §2.5 — cash path confirmation for Step 4.
// No admin approval step. All writes (product_selection + inventory + warranty
// + after-sales) execute in a single transaction.
//
// The transaction lives in `src/lib/leads/confirm-cash-sale.ts`: a cash sale can
// now also be completed from a WhatsApp turn, and this is one of only two places
// in the app where stock and money move. This route keeps auth, ownership,
// body validation and HTTP shaping.

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
  // Charger is optional — battery-only sales (with or without paraphernalia)
  // are a valid order. When null/undefined, charger inventory is left alone.
  chargerSerial: z.string().min(1).nullable().optional(),
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
  // E-103: was subCategory; renamed to modelNumber to mirror the
  // product_selections.model_number column (Sync Audit G-05).
  modelNumber: z.string().optional(),
  // E-130 / Addendum V0.1 §5.1 — battery/charger photos apply to cash too
  // (Sections B/C are shared). Section G fields are finance-only and ignored
  // here, but accepted for forwards-compat.
  batteryPhotoUrls: z.array(storedFileUrl).optional(),
  chargerPhotoUrls: z.array(storedFileUrl).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;
    const body = BodySchema.parse(await req.json());

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

    const result = await confirmCashSale({
      leadId,
      body,
      performedBy: user.id,
      dealerId: user.dealer_id!,
    });

    return NextResponse.json({
      success: true,
      data: {
        leadStatus: result.leadStatus,
        productSelectionId: result.productSelectionId,
        warrantyId: result.warrantyId,
        warrantyStart: result.warrantyStart.toISOString(),
        warrantyEnd: result.warrantyEnd.toISOString(),
        afterSalesId: result.afterSalesId,
        paymentMode: result.paymentMode,
        message: "Sale confirmed. Inventory sold. Warranty activated.",
      },
    });
  } catch (error) {
    console.error("[Confirm Cash Sale] Error:", error);
    // Every failure was a flat 400 before the extraction; the service now
    // distinguishes a stolen serial (409) and a missing lead (404).
    if (error instanceof CashSaleError) {
      return NextResponse.json(
        { success: false, error: { message: error.message } },
        { status: error.status },
      );
    }
    const message = error instanceof Error ? error.message : "Failed to confirm sale";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 400 },
    );
  }
}
