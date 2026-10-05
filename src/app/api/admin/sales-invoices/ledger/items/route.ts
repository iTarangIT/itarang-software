/**
 * E-322 (tracker ID 39) — Vyapar item name → CRM product mapping.
 *
 * GET  — every item name seen on invoice lines / in the map, with how many
 *        lines and units carry it and what it is mapped to; unmapped first.
 *        Also the product catalogue for the picker.
 * POST { item_name, asset_type, product_id } — map (or unmap with nulls);
 *        lines already imported under that name are updated too.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { listOemCatalogue } from "@/lib/leads/oemPrices";
import { mapVyaparItem } from "@/lib/sales/vyaparImport";
import { requireLedger } from "../_auth";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
    item_name: z.string().trim().min(1).max(300),
    asset_type: z.enum(["battery", "charger", "paraphernalia"]).nullable(),
    product_id: z.string().trim().min(1).max(100).nullable(),
});

export const GET = withErrorHandler(async () => {
    await requireLedger();
    const items = await db.execute(sql`
        WITH seen AS (
            SELECT lower(regexp_replace(btrim(item_name), '\\s+', ' ', 'g')) AS item_key,
                   min(item_name) AS item_name,
                   count(*)::int AS lines,
                   COALESCE(sum(quantity), 0)::float8 AS units,
                   min(product_class) AS product_class
              FROM invoice_line_items
             WHERE item_name IS NOT NULL
             GROUP BY 1
        )
        SELECT COALESCE(m.item_key, s.item_key)   AS item_key,
               COALESCE(m.item_name, s.item_name) AS item_name,
               COALESCE(s.lines, 0)               AS lines,
               COALESCE(s.units, 0)               AS units,
               s.product_class,
               m.asset_type, m.product_id
          FROM seen s
          FULL JOIN vyapar_item_map m ON m.item_key = s.item_key
         ORDER BY (m.product_id IS NULL) DESC, COALESCE(s.lines, 0) DESC
         LIMIT 500
    `);
    const catalogue = await listOemCatalogue();
    return successResponse({
        items,
        products: catalogue.map((p) => ({
            asset_type: p.asset_type,
            product_id: p.product_id,
            product_name: p.product_name,
            model_id: p.model_id,
        })),
    });
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireLedger();
    const body = BodySchema.parse(await req.json());
    const result = await mapVyaparItem({
        itemName: body.item_name,
        assetType: body.product_id ? body.asset_type : null,
        productId: body.product_id,
        actorId: user.id,
    });
    return successResponse(result);
});
