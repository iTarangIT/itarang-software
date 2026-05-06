import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { paraphernaliaStock, productCategories } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";

async function resolveCategoryName(input: string): Promise<string> {
  const [cat] = await db
    .select({ name: productCategories.name })
    .from(productCategories)
    .where(eq(productCategories.id, input))
    .limit(1);
  return cat?.name ?? input;
}

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
    const categoryName = category ? await resolveCategoryName(category) : null;

    const rows = await db
      .select()
      .from(paraphernaliaStock)
      .where(and(eq(paraphernaliaStock.dealer_id, dealerId)));

    const filtered = rows.filter((r) => {
      if (!categoryName) return true;
      const cats = Array.isArray(r.compatible_categories)
        ? (r.compatible_categories as string[])
        : [];
      return cats.includes(categoryName);
    });

    const data = filtered.map((r) => {
      const gross = Number(r.unit_cost ?? 0);
      const gstPct = 0;
      const gstAmt = 0;
      return {
        product_id: null,
        asset_type: r.item_type,
        model_type: r.item_label,
        product_name: r.item_label,
        available_qty: r.available_qty,
        reserved_qty: r.reserved_qty,
        sold_qty: r.sold_qty,
        unit_price: gross,
        gst_percent: gstPct.toFixed(2),
        unit_gross: gross,
        unit_gst_amount: gstAmt,
        unit_net: gross + gstAmt,
        compatible_categories: r.compatible_categories,
      };
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[Dealer Paraphernalia] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to load paraphernalia";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
