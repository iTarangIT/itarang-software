import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { inventory, products } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";

// BRD V2 §2.3 — dealer paraphernalia stock for Step 4.
// Paraphernalia is count-tracked (not per-serial). We aggregate quantity per
// asset_type for the dealer and return a summary list.

const PARAPHERNALIA_TYPES = ["SOC", "Harness", "Inverter", "DigitalSOC", "VoltSOC"];

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
    if (category) filters.push(eq(inventory.asset_category, category));

    // Aggregate quantity per asset_type + model_type
    const rows = await db
      .select({
        asset_type: inventory.asset_type,
        model_type: inventory.model_type,
        product_name: products.name,
        available_qty: sql<number>`sum(coalesce(${inventory.quantity}, 1))::int`,
        unit_price: products.price,
      })
      .from(inventory)
      .leftJoin(products, eq(inventory.product_id, products.id))
      .where(and(...filters))
      .groupBy(inventory.asset_type, inventory.model_type, products.name, products.price);

    return NextResponse.json({ success: true, data: rows });
  } catch (error) {
    console.error("[Dealer Paraphernalia] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to load paraphernalia";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
