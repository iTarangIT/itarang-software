// GET /api/inside-sales/products
// Product master for the Update Commercials product picker. Sources the three
// BRD product-master tables — batteries / chargers / paraphernalia — and
// normalises each into one ProductMasterOption shape so the modal stays
// simple. Active rows only.
//
// Each option also carries its live LIST price (shown beside the unit-price
// field for reference) and its GST rate (so the form can show GST and the
// total incl. GST). The OEM reference price is deliberately NOT read here: it
// is internal and salespeople must never see it — so a product with no list
// price shows none — and the PDF prints none either.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import type {
    CommercialsProductLine,
    ProductMasterOption,
    ProductMasterResponse,
} from "@/lib/inside-sales/types";
import { loadLiveListPrices } from "@/lib/leads/listPrices";
import { refKey } from "@/lib/leads/oemPricing";
import { DEFAULT_TAX_BY_ASSET_TYPE, taxRefKey } from "@/lib/leads/quote-pdf/view";
import { loadLineTaxRefs } from "@/lib/leads/quote-pdf/view-store";

export const dynamic = "force-dynamic";

// E-358: Sales Head and CEO raise account quotations, which pick from the same master.
const READ_ROLES = ["inside_sales_rep", "asm", "admin", "partner", "sales_head", "ceo"];

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

    // List price + GST rate, looked up for every option in one pass each. Both
    // are best-effort: a database without E-321 has no list prices, and a
    // master that errors on its tax columns falls back to the asset-type rate.
    const all: CommercialsProductLine[] = (["battery", "charger", "paraphernalia"] as const).flatMap((t) =>
        body[t].map((o) => ({
            asset_type: t,
            product_id: o.id,
            product_name: o.label,
            model_id: o.model_id,
            unit_price: null,
            quantity: 1,
        })),
    );
    const [listRefs, taxRefs] = await Promise.all([
        loadLiveListPrices(all).catch((e) => {
            console.warn("[inside-sales/products] list prices unavailable", e);
            return new Map<string, { list_price: number }>();
        }),
        loadLineTaxRefs(all),
    ]);
    for (const t of ["battery", "charger", "paraphernalia"] as const) {
        body[t] = body[t].map((o) => ({
            ...o,
            list_price: listRefs.get(refKey(t, o.id))?.list_price ?? null,
            gst_rate_pct:
                taxRefs.get(taxRefKey(t, o.id))?.gstRatePct ?? DEFAULT_TAX_BY_ASSET_TYPE[t]?.gstRatePct ?? null,
        }));
    }

    return successResponse(body);
});
