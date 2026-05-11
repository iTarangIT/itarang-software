import { NextResponse } from "next/server";
import { and, eq, notInArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { inventory, paraphernaliaStock, products } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";

type AggregatedRow = {
  id: string;
  product_name: string;
  sku: string;
  category: string;
  quantity_available: number;
  quantity_reserved: number;
  quantity_sold: number;
  unit_price: number;
  warehouse_location: string | null;
  received_at: string | null;
  is_new: boolean;
  status: "in_stock" | "low_stock" | "out_of_stock";
};

const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LOW_STOCK_THRESHOLD = 5;

function deriveStockStatus(available: number): AggregatedRow["status"] {
  if (available <= 0) return "out_of_stock";
  if (available <= LOW_STOCK_THRESHOLD) return "low_stock";
  return "in_stock";
}

export async function GET() {
  try {
    const user = await requireRole(["dealer"]);
    const dealerId = user.dealer_id;
    if (!dealerId) {
      return NextResponse.json(
        { success: false, error: { message: "No dealer account is linked to this user." } },
        { status: 403 },
      );
    }

    const serialRows = await db
      .select({
        id: inventory.id,
        asset_category: inventory.asset_category,
        asset_type: inventory.asset_type,
        model_type: inventory.model_type,
        product_name: products.name,
        status: inventory.status,
        final_amount: inventory.final_amount,
        warehouse_location: inventory.warehouse_location,
        allocated_to_dealer_at: inventory.allocated_to_dealer_at,
        created_at: inventory.created_at,
      })
      .from(inventory)
      .leftJoin(products, eq(inventory.product_id, products.id))
      .where(
        and(
          eq(inventory.dealer_id, dealerId),
          notInArray(inventory.status, ["transferred_out", "write-off"]),
        ),
      );

    const groups = new Map<
      string,
      {
        category: string;
        product_name: string;
        sku: string;
        warehouse_location: string | null;
        unit_price: number;
        quantity_available: number;
        quantity_reserved: number;
        quantity_sold: number;
        latest_received: number | null;
      }
    >();

    for (const r of serialRows) {
      const sku = r.model_type ?? "";
      // Dealer UI filters on item type (Battery/Charger/Paraphernalia), which lives
      // in asset_type. asset_category holds vehicle class ("3W"/"2W") and is the wrong axis here.
      const category = r.asset_type ?? r.asset_category ?? "Other";
      const key = `${category}__${sku}`;
      const existing = groups.get(key) ?? {
        category,
        product_name: r.product_name ?? r.model_type ?? "Unnamed product",
        sku,
        warehouse_location: r.warehouse_location ?? null,
        unit_price: 0,
        quantity_available: 0,
        quantity_reserved: 0,
        quantity_sold: 0,
        latest_received: null,
      };

      if (r.status === "available") existing.quantity_available += 1;
      else if (r.status === "reserved") existing.quantity_reserved += 1;
      else if (r.status === "sold" || r.status === "dispatched") existing.quantity_sold += 1;

      if (existing.unit_price === 0 && r.final_amount) {
        const parsed = Number(r.final_amount);
        if (!Number.isNaN(parsed)) existing.unit_price = parsed;
      }
      if (!existing.warehouse_location && r.warehouse_location) {
        existing.warehouse_location = r.warehouse_location;
      }
      if (!existing.product_name && r.product_name) existing.product_name = r.product_name;

      const receivedTs = r.allocated_to_dealer_at
        ? new Date(r.allocated_to_dealer_at).getTime()
        : r.created_at
          ? new Date(r.created_at).getTime()
          : null;
      if (receivedTs !== null) {
        existing.latest_received =
          existing.latest_received === null ? receivedTs : Math.max(existing.latest_received, receivedTs);
      }

      groups.set(key, existing);
    }

    const paraRows = await db
      .select({
        id: paraphernaliaStock.id,
        item_type: paraphernaliaStock.item_type,
        item_label: paraphernaliaStock.item_label,
        available_qty: paraphernaliaStock.available_qty,
        reserved_qty: paraphernaliaStock.reserved_qty,
        sold_qty: paraphernaliaStock.sold_qty,
        unit_cost: paraphernaliaStock.unit_cost,
        last_upload_at: paraphernaliaStock.last_upload_at,
      })
      .from(paraphernaliaStock)
      .where(eq(paraphernaliaStock.dealer_id, dealerId));

    const now = Date.now();
    const rows: AggregatedRow[] = [];

    for (const [key, g] of groups.entries()) {
      const isNew = g.latest_received !== null && now - g.latest_received <= NEW_WINDOW_MS;
      rows.push({
        id: key,
        product_name: g.product_name,
        sku: g.sku,
        category: g.category,
        quantity_available: g.quantity_available,
        quantity_reserved: g.quantity_reserved,
        quantity_sold: g.quantity_sold,
        unit_price: g.unit_price,
        warehouse_location: g.warehouse_location,
        received_at: g.latest_received ? new Date(g.latest_received).toISOString() : null,
        is_new: isNew,
        status: deriveStockStatus(g.quantity_available),
      });
    }

    for (const p of paraRows) {
      const receivedTs = p.last_upload_at ? new Date(p.last_upload_at).getTime() : null;
      const unitPrice = p.unit_cost ? Number(p.unit_cost) : 0;
      rows.push({
        id: `paraphernalia__${p.id}`,
        product_name: p.item_label,
        sku: p.item_type,
        category: "Paraphernalia",
        quantity_available: p.available_qty ?? 0,
        quantity_reserved: p.reserved_qty ?? 0,
        quantity_sold: p.sold_qty ?? 0,
        unit_price: Number.isNaN(unitPrice) ? 0 : unitPrice,
        warehouse_location: null,
        received_at: receivedTs ? new Date(receivedTs).toISOString() : null,
        is_new: receivedTs !== null && now - receivedTs <= NEW_WINDOW_MS,
        status: deriveStockStatus(p.available_qty ?? 0),
      });
    }

    rows.sort((a, b) => {
      const ta = a.received_at ? new Date(a.received_at).getTime() : 0;
      const tb = b.received_at ? new Date(b.received_at).getTime() : 0;
      return tb - ta;
    });

    return NextResponse.json({ success: true, data: { rows } });
  } catch (error) {
    console.error("[Dealer Inventory] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to load inventory";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
