// ID 147 — link invoice lines that were stored before their item was mapped.
//
//   node --import tsx --env-file=.env.local      scripts/relink-unmapped-lines.ts            (dry run)
//   node --import tsx --env-file=.env.production scripts/relink-unmapped-lines.ts --apply
//
// Until ID 147, only the Vyapar import stamped a line with its product. Drive and
// Zoho lines came in with product_id NULL even when Invoice Ledger › Item mapping
// already had the item, and stayed "not linked" until someone saved that
// mapping again. Writers now stamp at insert (src/lib/sales/itemMap.ts); this
// fixes the lines already stored. It sets asset_type / product_id from
// vyapar_item_map on lines that have none — exactly what mapVyaparItem() does
// when a mapping is saved — and never changes a line that is already linked.
// Re-run = no-op.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { itemKeySql } from "@/lib/sales/itemMap";
import { hasInvoiceLedgerTables } from "@/lib/sales/ledgerTables";

type Stat = { source: string; lines: number; items: number };

async function main() {
    const apply = process.argv.includes("--apply");
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}`);
    console.log(apply ? "Mode: APPLY\n" : "Mode: dry run (add --apply to link)\n");
    if (!(await hasInvoiceLedgerTables())) {
        console.log("SKIP  invoice ledger (E-322) not on this database");
        process.exit(0);
    }

    const key = itemKeySql(sql`l.item_name`);
    const stale = (await db.execute(sql`
        SELECT l.source, COUNT(*)::int AS lines, COUNT(DISTINCT m.item_key)::int AS items
          FROM invoice_line_items l
          JOIN vyapar_item_map m ON m.item_key = ${key}
         WHERE l.product_id IS NULL AND m.product_id IS NOT NULL
         GROUP BY l.source ORDER BY l.source
    `)) as unknown as Stat[];
    if (stale.length === 0) {
        console.log("Nothing to link — every line of a mapped item already has its product.");
        process.exit(0);
    }
    for (const s of stale) console.log(`  ${s.source.padEnd(8)} ${s.lines} line(s) of ${s.items} mapped item(s)`);
    if (!apply) process.exit(0);

    const [done] = (await db.execute(sql`
        WITH u AS (
            UPDATE invoice_line_items l
               SET asset_type = m.asset_type, product_id = m.product_id
              FROM vyapar_item_map m
             WHERE m.item_key = ${key}
               AND l.product_id IS NULL AND m.product_id IS NOT NULL
            RETURNING 1)
        SELECT COUNT(*)::int AS n FROM u
    `)) as unknown as Array<{ n: number }>;
    console.log(`\nLinked ${done?.n ?? 0} line(s).`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
