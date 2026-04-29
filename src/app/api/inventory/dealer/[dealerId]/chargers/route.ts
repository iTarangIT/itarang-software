import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { inventory, products, productCategories } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";

// inventory.asset_category stores the productCategories.name. Callers
// may pass either the category id or the name — resolve to the name.
async function resolveCategoryName(input: string): Promise<string> {
  const [cat] = await db
    .select({ name: productCategories.name })
    .from(productCategories)
    .where(eq(productCategories.id, input))
    .limit(1);
  return cat?.name ?? input;
}

// BRD V2 §2.3 — dealer charger inventory list for Step 4.
// Chargers are filtered by compatibility with the selected battery model.
// Since the schema does not track explicit compatibility yet, we filter by
// matching `model_type` on the inventory row when batteryModel is supplied.

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ dealerId: string }> },
) {
  try {
    const user = await requireAuth();
    const { dealerId } = await params;

    if (user.role === "dealer" && user.dealer_id !== dealerId) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(req.url);
    const batteryModel = searchParams.get("batteryModel");
    const category = searchParams.get("category");

    const filters = [
      eq(inventory.dealer_id, dealerId),
      eq(inventory.asset_type, "Charger"),
      eq(inventory.status, "available"),
    ];
    if (category) {
      const categoryName = await resolveCategoryName(category);
      filters.push(eq(inventory.asset_category, categoryName));
    }
    // Best-effort compatibility filter: match on model_type if supplied.
    if (batteryModel) filters.push(eq(inventory.model_type, batteryModel));

    const rows = await db
      .select({
        id: inventory.id,
        serial_number: inventory.serial_number,
        model_name: products.name,
        model_type: inventory.model_type,
        asset_category: inventory.asset_category,
        invoice_date: inventory.oem_invoice_date,
        status: inventory.status,
        price: products.price,
        warranty_months: products.warranty_months,
        gross_amount: inventory.inventory_amount,
        gst_percent: inventory.gst_percent,
        gst_amount: inventory.gst_amount,
        net_amount: inventory.final_amount,
      })
      .from(inventory)
      .leftJoin(products, eq(inventory.product_id, products.id))
      .where(and(...filters))
      .orderBy(asc(inventory.oem_invoice_date));

    const today = Date.now();
    const enriched = rows.map((r, i) => {
      const ageMs = r.invoice_date ? today - new Date(r.invoice_date).getTime() : 0;
      const ageDays = Math.max(0, Math.floor(ageMs / (1000 * 60 * 60 * 24)));
      let ageBadge: "fresh" | "ageing" | "old" = "fresh";
      if (ageDays > 180) ageBadge = "old";
      else if (ageDays > 90) ageBadge = "ageing";
      return {
        ...r,
        inventory_age_days: ageDays,
        age_badge: ageBadge,
        recommended: i === 0,
      };
    });

    return NextResponse.json({ success: true, data: enriched });
  } catch (error) {
    console.error("[Dealer Chargers] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to load chargers";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
