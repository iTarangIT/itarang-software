import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { inventory, products, productCategories } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";

// inventory.asset_category stores the productCategories.name (set at
// bulk-upload time). Callers may pass either the category id or the
// name — resolve to the name so both work.
async function resolveCategoryName(input: string): Promise<string> {
  const [cat] = await db
    .select({ name: productCategories.name })
    .from(productCategories)
    .where(eq(productCategories.id, input))
    .limit(1);
  return cat?.name ?? input;
}

// BRD V2 §2.3 — dealer battery inventory list for Step 4.
// Filters: dealer_id + asset_type=Battery + status=available.
// Optional query params: category, subCategory.
// Sort: oem_invoice_date ASC (oldest first — BRD ageing priority rule).

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ dealerId: string }> },
) {
  try {
    const user = await requireAuth();
    const { dealerId } = await params;

    // Dealer can only view their own inventory; admins can view any dealer's.
    if (user.role === "dealer" && user.dealer_id !== dealerId) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(req.url);
    const category = searchParams.get("category");
    const subCategory = searchParams.get("subCategory");
    const productId = searchParams.get("productId");

    const filters = [
      eq(inventory.dealer_id, dealerId),
      eq(inventory.asset_type, "Battery"),
      eq(inventory.status, "available"),
    ];
    if (category) {
      const categoryName = await resolveCategoryName(category);
      filters.push(eq(inventory.asset_category, categoryName));
    }
    // When the lead has a primary_product_id (Step 1 "Product Type"),
    // restrict inventory to that exact product. Falls back to free
    // listing when no productId is supplied.
    if (productId) filters.push(eq(inventory.product_id, productId));
    if (subCategory) filters.push(eq(inventory.model_type, subCategory));

    const rows = await db
      .select({
        id: inventory.id,
        serial_number: inventory.serial_number,
        model_name: products.name,
        model_type: inventory.model_type,
        asset_category: inventory.asset_category,
        invoice_date: inventory.oem_invoice_date,
        soc_percent: inventory.soc_percent,
        soc_last_sync_at: inventory.soc_last_sync_at,
        status: inventory.status,
        price: products.price,
        voltage_v: products.voltage_v,
        capacity_ah: products.capacity_ah,
        warranty_months: products.warranty_months,
        // GST snapshot — already captured per inventory row at OEM upload.
        gross_amount: inventory.inventory_amount,
        gst_percent: inventory.gst_percent,
        gst_amount: inventory.gst_amount,
        net_amount: inventory.final_amount,
      })
      .from(inventory)
      .leftJoin(products, eq(inventory.product_id, products.id))
      .where(and(...filters))
      .orderBy(asc(inventory.oem_invoice_date));

    // Compute inventory_age in days + ageing badge per BRD §3842.
    const today = Date.now();
    const enriched = rows.map((r) => {
      const ageMs = r.invoice_date ? today - new Date(r.invoice_date).getTime() : 0;
      const ageDays = Math.max(0, Math.floor(ageMs / (1000 * 60 * 60 * 24)));
      let ageBadge: "fresh" | "ageing" | "old" = "fresh";
      if (ageDays > 180) ageBadge = "old";
      else if (ageDays > 90) ageBadge = "ageing";
      return {
        ...r,
        inventory_age_days: ageDays,
        age_badge: ageBadge,
      };
    });

    // Recommendation flag = oldest available (first row in ASC sort).
    const withRecommend = enriched.map((r, i) => ({
      ...r,
      recommended: i === 0,
    }));

    return NextResponse.json({ success: true, data: withRecommend });
  } catch (error) {
    console.error("[Dealer Batteries] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to load batteries";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
