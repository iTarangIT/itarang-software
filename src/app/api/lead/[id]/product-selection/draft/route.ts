import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { leads, productSelections } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { generateId } from "@/lib/api-utils";

// BRD V2 §2.4 — Step 4 "Save Draft" persistence.
// Upserts a product_selections row with admin_decision='draft'. Does NOT
// reserve inventory and does NOT advance lead.kyc_status — those happen on
// formal submit. The draft row is what makes the lead appear in
// /dealer-portal/leads/drafts.

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

// All fields optional — drafts can be partial.
const BodySchema = z.object({
  batterySerial: z.string().nullable().optional(),
  chargerSerial: z.string().nullable().optional(),
  paraphernalia: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  paraphernaliaLines: z.array(ParaLineSchema).optional(),
  dealerMargin: z.number().min(0).optional(),
  finalPrice: z.number().min(0).optional(),
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

const numOrNull = (n: number | undefined) =>
  n === undefined ? null : n.toString();

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

    // Find existing draft for this lead (one draft per lead).
    const [existingDraft] = await db
      .select()
      .from(productSelections)
      .where(
        and(
          eq(productSelections.lead_id, leadId),
          eq(productSelections.admin_decision, "draft"),
        ),
      )
      .orderBy(desc(productSelections.created_at))
      .limit(1);

    const now = new Date();
    const paymentMode = String(lead.payment_method || "").toLowerCase() === "cash" ? "cash" : "finance";

    const draftValues = {
      battery_serial: body.batterySerial ?? null,
      charger_serial: body.chargerSerial ?? null,
      paraphernalia: body.paraphernalia ?? {},
      paraphernalia_lines: body.paraphernaliaLines ?? [],
      category: body.category || lead.product_category_id || null,
      sub_category: body.subCategory || lead.product_type_id || null,
      battery_price: numOrNull(body.batteryPrice),
      charger_price: numOrNull(body.chargerPrice),
      paraphernalia_cost: numOrNull(body.paraphernaliaCost),
      dealer_margin: numOrNull(body.dealerMargin),
      final_price: numOrNull(body.finalPrice),
      battery_gross: numOrNull(body.batteryGross),
      battery_gst_percent: numOrNull(body.batteryGstPercent),
      battery_gst_amount: numOrNull(body.batteryGstAmount),
      battery_net: numOrNull(body.batteryNet),
      charger_gross: numOrNull(body.chargerGross),
      charger_gst_percent: numOrNull(body.chargerGstPercent),
      charger_gst_amount: numOrNull(body.chargerGstAmount),
      charger_net: numOrNull(body.chargerNet),
      gross_subtotal: numOrNull(body.grossSubtotal),
      gst_subtotal: numOrNull(body.gstSubtotal),
      net_subtotal: numOrNull(body.netSubtotal),
      payment_mode: paymentMode,
      admin_decision: "draft",
      submitted_by: user.id,
      submitted_at: null as Date | null, // null while in draft
      updated_at: now,
    };

    let draftId: string;
    await db.transaction(async (tx) => {
      if (existingDraft) {
        await tx
          .update(productSelections)
          .set(draftValues)
          .where(eq(productSelections.id, existingDraft.id));
        draftId = existingDraft.id;
      } else {
        draftId = await generateId("PS");
        await tx.insert(productSelections).values({
          id: draftId,
          lead_id: leadId,
          ...draftValues,
          created_at: now,
        });
      }

      // Bump leads.workflow_step + updated_at so My Drafts shows "Step 4"
      // and orders this lead to the top.
      await tx
        .update(leads)
        .set({ workflow_step: 4, updated_at: now })
        .where(eq(leads.id, leadId));
    });

    return NextResponse.json({
      success: true,
      data: {
        productSelectionId: draftId!,
        savedAt: now.toISOString(),
      },
    });
  } catch (error) {
    console.error("[Product Selection Draft] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to save draft";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 400 },
    );
  }
}
