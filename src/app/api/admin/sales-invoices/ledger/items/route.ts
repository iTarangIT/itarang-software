/**
 * E-322 (tracker ID 39) — Vyapar item name → CRM product mapping.
 *
 * GET  — one row per PRODUCT FAMILY seen on invoice lines (itemFamilyKey:
 *        product code, else the name with serial numbers / colour / warranty
 *        text taken out), with how many spellings, lines and units it covers
 *        and what it is mapped to; unmapped first. Also the product catalogue.
 * POST { item_name, asset_type, product_id } — map (or unmap with nulls) the
 *        name and its family; every line of the family is updated too.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { listOemCatalogue } from "@/lib/leads/oemPrices";
import { mapVyaparItem } from "@/lib/sales/vyaparImport";
import { itemFamilyKey, itemKey } from "@/lib/sales/invoiceLines";
import { requireLedger } from "../_auth";
import { ONBOARDING_FEE_ITEM } from "@/lib/leads/dealCardRules";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
    item_name: z.string().trim().min(1).max(300),
    // ID 172: "onboarding_fee" maps a fee line (product_id = "onboarding_fee").
    asset_type: z.enum(["battery", "charger", "paraphernalia", ONBOARDING_FEE_ITEM]).nullable(),
    product_id: z.string().trim().min(1).max(100).nullable(),
});

type ItemRow = {
    item_key: string;
    item_name: string;
    lines: number;
    units: number;
    product_class: string | null;
    asset_type: string | null;
    product_id: string | null;
};

export const GET = withErrorHandler(async () => {
    await requireLedger();
    const raw = (await db.execute(sql`
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
         WHERE m.item_key IS NULL OR (m.item_key NOT LIKE 'code:%' AND m.item_key NOT LIKE 'name:%')
         ORDER BY COALESCE(s.lines, 0) DESC
         LIMIT 2000
    `)) as unknown as ItemRow[];
    const familyMaps = new Map(
        ((await db.execute(sql`
            SELECT item_key, asset_type, product_id FROM vyapar_item_map
             WHERE item_key LIKE 'code:%' OR item_key LIKE 'name:%'
        `)) as unknown as Array<{ item_key: string; asset_type: string | null; product_id: string | null }>).map((r) => [r.item_key, r]),
    );
    // Fold spellings into their family: the most-billed spelling names the row,
    // and the family's mapping (else that spelling's own) is what it shows.
    const groups = new Map<string, ItemRow & { spellings: string[] }>();
    for (const r of raw) {
        const fk = itemFamilyKey(r.item_name) ?? r.item_key;
        const g = groups.get(fk);
        if (!g) {
            groups.set(fk, { ...r, lines: Number(r.lines), units: Number(r.units), spellings: [r.item_name] });
            continue;
        }
        g.lines += Number(r.lines);
        g.units += Number(r.units);
        g.spellings.push(r.item_name);
        if (!g.product_id && r.product_id) {
            g.asset_type = r.asset_type;
            g.product_id = r.product_id;
        }
    }
    const items = [...groups.entries()]
        .map(([fk, g]) => {
            const fam = familyMaps.get(fk);
            return {
                ...g,
                item_key: itemKey(g.item_name),
                family_key: fk,
                asset_type: fam?.product_id ? fam.asset_type : g.asset_type,
                product_id: fam?.product_id ?? g.product_id,
            };
        })
        .sort((a, b) => Number(a.product_id != null) - Number(b.product_id != null) || b.lines - a.lines)
        .slice(0, 500);
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
