import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";

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

// BRD V2 §2.3 — dealer paraphernalia stock for Step 4.
// Paraphernalia is count-tracked (not per-serial). We aggregate quantity per
// asset_type for the dealer and return a summary list.

const PARAPHERNALIA_TYPES = [
  "SOC",
  "Harness",
  "Inverter",
  "DigitalSOC",
  "VoltSOC",
  "IOT",
];

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
    const category = searchParams.get("category");

    const filters = [
      eq(inventory.dealer_id, dealerId),
      eq(inventory.status, "available"),
      inArray(inventory.asset_type, PARAPHERNALIA_TYPES),
    ];
    if (category) {
      const categoryName = await resolveCategoryName(category);
      filters.push(eq(inventory.asset_category, categoryName));
    }

    // Aggregate quantity per asset_type + model_type + product. We surface
    // per-unit gross / GST so the dealer-side UI can render the BRD-spec
    // 5-column line (Gross | GST % | GST ₹ | Qty | Net) per item.
    const rows = await db
      .select({
        product_id: inventory.product_id,
        asset_type: inventory.asset_type,
        model_type: inventory.model_type,
        product_name: products.name,
        available_qty: sql<number>`sum(coalesce(${inventory.quantity}, 1))::int`,
        unit_price: products.price,
        // gst_percent is consistent across inventory rows for the same product;
        // use AVG to collapse to a single number.
        gst_percent: sql<string>`avg(${inventory.gst_percent})::numeric(5,2)`,
      })
      .from(inventory)
      .leftJoin(products, eq(inventory.product_id, products.id))
      .where(and(...filters))
      .groupBy(
        inventory.product_id,
        inventory.asset_type,
        inventory.model_type,
        products.name,
        products.price,
      );

    const enriched = rows.map((r) => {
      const gross = Number(r.unit_price ?? 0);
      const gstPct = Number(r.gst_percent ?? 0);
      const gstAmt = Math.round((gross * gstPct) / 100);
      return {
        ...r,
        unit_gross: gross,
        unit_gst_amount: gstAmt,
        unit_net: gross + gstAmt,
      };
    });

    return NextResponse.json({ success: true, data: enriched });
  } catch (error) {
    console.error("[Dealer Paraphernalia] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to load paraphernalia";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
