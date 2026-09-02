// GET /api/inside-sales/products
// Product master for the Update Commercials product picker. Sources the three
// BRD product-master tables — batteries / chargers / paraphernalia — and
// normalises each into one ProductMasterOption shape so the modal stays
// simple. Active rows only.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import type {
    ProductMasterOption,
    ProductMasterResponse,
} from "@/lib/inside-sales/types";

export const dynamic = "force-dynamic";

const READ_ROLES = ["inside_sales_rep", "asm", "admin"];

export const GET = withErrorHandler(async () => {
    await requireRole(READ_ROLES);

    const [batteries, chargers, paraphernalia] = await Promise.all([
        db.execute<{
            id: string;
            model_id: string;
            model_name: string;
            voltage_v: string | null;
            capacity_ah: string | null;
        }>(sql`
            SELECT id::text AS id, model_id, model_name,
                   voltage_v::text AS voltage_v, capacity_ah::text AS capacity_ah
            FROM product_master_batteries
            WHERE status = 'active'
            ORDER BY model_name ASC
        `),
        db.execute<{
            id: string;
            model_id: string;
            model_name: string;
            base_price: string | null;
            charging_type: string | null;
        }>(sql`
            SELECT id::text AS id, model_id, model_name,
                   base_price::text AS base_price, charging_type
            FROM product_master_chargers
            WHERE status = 'active'
            ORDER BY model_name ASC
        `),
        db.execute<{
            id: string;
            item_type_code: string;
            display_label: string;
            max_qty_per_lead: number | null;
        }>(sql`
            SELECT id::text AS id, item_type_code, display_label, max_qty_per_lead
            FROM product_master_paraphernalia
            WHERE status = 'active'
            ORDER BY display_label ASC
        `),
    ]);

    const body: ProductMasterResponse = {
        battery: (batteries as unknown as Record<string, unknown>[]).map(
            (b): ProductMasterOption => ({
                id: String(b.id),
                label: String(b.model_name),
                model_id: String(b.model_id),
                detail: [
                    b.voltage_v ? `${b.voltage_v}V` : null,
                    b.capacity_ah ? `${b.capacity_ah}Ah` : null,
                ]
                    .filter(Boolean)
                    .join(" · ") || null,
                unit_price: null,
                max_quantity: null,
            }),
        ),
        charger: (chargers as unknown as Record<string, unknown>[]).map(
            (c): ProductMasterOption => ({
                id: String(c.id),
                label: String(c.model_name),
                model_id: String(c.model_id),
                detail: c.charging_type ? String(c.charging_type) : null,
                unit_price: c.base_price != null ? Number(c.base_price) : null,
                max_quantity: null,
            }),
        ),
        paraphernalia: (
            paraphernalia as unknown as Record<string, unknown>[]
        ).map(
            (p): ProductMasterOption => ({
                id: String(p.id),
                label: String(p.display_label),
                model_id: String(p.item_type_code),
                detail: null,
                unit_price: null,
                // Commercials quantity is unrestricted — the product-master
                // max_qty_per_lead cap is NOT applied to quote lines.
                max_quantity: null,
            }),
        ),
    };

    return successResponse(body);
});
