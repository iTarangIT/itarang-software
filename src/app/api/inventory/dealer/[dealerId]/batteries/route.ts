import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { inventory, products } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";

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

    const filters = [
      eq(inventory.dealer_id, dealerId),
      eq(inventory.asset_type, "Battery"),
      eq(inventory.status, "available"),
    ];
    if (category) filters.push(eq(inventory.asset_category, category));
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
