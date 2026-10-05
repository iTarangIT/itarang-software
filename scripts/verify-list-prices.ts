// Read-only check for tracker IDs 4 and 47 (product list prices, E-323).
//
// Uses the REAL rules (src/lib/leads/listPricing.ts) and the REAL catalogue
// (src/lib/leads/listPrices.ts) to confirm, on whichever DB .env.local points at:
//   1. E-323 is applied;
//   2. no open list price sits below an open OEM price it overlaps;
//   3. no product has two open list price windows that overlap;
//   4. how many products have a list price, and how many quotes carry a snapshot.
//
//   node --import tsx --env-file=.env.local scripts/verify-list-prices.ts

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { listListPriceCatalogue } from "@/lib/leads/listPriceCatalogue";
import { firstOemAboveList, windowsOverlap } from "@/lib/leads/listPricing";

type Line = { asset_type: string; product_id: string; price: string; effective_from: string; valid_until: string | null };

const win = (l: Line) => ({ from: new Date(l.effective_from), until: l.valid_until ? new Date(l.valid_until) : null, price: Number(l.price) });
const keyOf = (l: Line) => `${l.asset_type}:${l.product_id}`;

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);

    const [applied] = (await db.execute(sql`
        SELECT to_regclass('public.product_list_prices') IS NOT NULL AS has_table,
               EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'dealer_lead_commercials' AND column_name = 'list_price_snapshot') AS has_snapshot
    `)) as unknown as { has_table: boolean; has_snapshot: boolean }[];
    if (!applied?.has_table || !applied?.has_snapshot) {
        console.log("E-323 is NOT applied here. Apply drizzle/E-323_product_list_prices.sql first.");
        process.exit(1);
    }

    const list = (await db.execute(sql`
        SELECT asset_type, product_id, list_price::text AS price, effective_from, valid_until
          FROM product_list_prices WHERE effective_to IS NULL
    `)) as unknown as Line[];
    const oem = (await db.execute(sql`
        SELECT asset_type, product_id, oem_price::text AS price, effective_from, valid_until
          FROM oem_reference_prices WHERE effective_to IS NULL
    `)) as unknown as Line[];

    const oemByProduct = new Map<string, Line[]>();
    for (const o of oem) oemByProduct.set(keyOf(o), [...(oemByProduct.get(keyOf(o)) ?? []), o]);
    const listByProduct = new Map<string, Line[]>();
    for (const l of list) listByProduct.set(keyOf(l), [...(listByProduct.get(keyOf(l)) ?? []), l]);

    let belowOem = 0;
    let overlapping = 0;
    for (const [k, lines] of listByProduct) {
        for (const l of lines) {
            const hit = firstOemAboveList(win(l), (oemByProduct.get(k) ?? []).map(win));
            if (hit) {
                belowOem += 1;
                console.log(`  BELOW OEM  ${k}: list ${l.price} < OEM ${hit.price} from ${hit.from.toISOString().slice(0, 10)}`);
            }
        }
        for (let i = 0; i < lines.length; i++) {
            for (let j = i + 1; j < lines.length; j++) {
                if (windowsOverlap(win(lines[i]), win(lines[j]))) {
                    overlapping += 1;
                    console.log(`  OVERLAP    ${k}: two open list price windows overlap`);
                }
            }
        }
    }

    const catalogue = await listListPriceCatalogue();
    const withList = catalogue.filter((p) => p.list_price != null).length;
    const scheduled = catalogue.filter((p) => p.next_list_price != null).length;
    const [quotes] = (await db.execute(sql`
        SELECT COUNT(*) FILTER (WHERE list_price_snapshot IS NOT NULL)::int AS with_snapshot,
               COUNT(*) FILTER (WHERE list_price_snapshot IS NOT NULL AND EXISTS (
                   SELECT 1 FROM jsonb_array_elements(list_price_snapshot -> 'lines') lp
                    WHERE lp ->> 'list_price' IS NOT NULL))::int AS with_list_price
          FROM dealer_lead_commercials
    `)) as unknown as { with_snapshot: number; with_list_price: number }[];

    console.log(`open list price lines: ${list.length}  ·  open OEM price lines: ${oem.length}`);
    console.log(`active products: ${catalogue.length}  ·  with a list price in force: ${withList}  ·  with one scheduled: ${scheduled}`);
    console.log(`quotes carrying a list price snapshot: ${quotes?.with_snapshot ?? 0}  ·  of which at least one line had a list price: ${quotes?.with_list_price ?? 0}`);
    console.log(`list price below OEM: ${belowOem}  ·  overlapping list windows: ${overlapping}`);
    console.log(belowOem + overlapping === 0 ? "OK" : "FAILED");
    process.exit(belowOem + overlapping === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
