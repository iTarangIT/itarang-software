// E-367 — one-off: put existing asm_territories rows into the canonical
// state / city spelling the territory API now writes, so automatic routing
// matches them ("bihar " → "Bihar", "Bangalore" → "Bengaluru").
//
//   node --import tsx --env-file=.env.local scripts/normalize-asm-territories.ts           # dry run
//   node --import tsx --env-file=.env.local scripts/normalize-asm-territories.ts --apply   # write
//
// Uses the real canonicalTerritoryPlace() the POST / PATCH routes use. Rows
// whose state is unknown are reported, never changed — fix them in Admin →
// Settings → ASM Territories.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { canonicalTerritoryPlace } from "@/lib/ai-dialer/territoryRouting";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

async function main() {
    const apply = process.argv.includes("--apply");
    const rows = rowsOf<{ id: string; asm: string; state: string; city: string | null }>(
        await db.execute(sql`
            SELECT t.territory_id::text AS id, COALESCE(u.name, u.email, t.asm_id) AS asm, t.state, t.city
              FROM asm_territories t
              LEFT JOIN users u ON u.id::text = t.asm_id
             ORDER BY t.state, t.city
        `),
    );
    let changed = 0;
    let unknown = 0;
    for (const r of rows) {
        const p = await canonicalTerritoryPlace({ state: r.state, city: r.city });
        if (p.unknownState) {
            unknown++;
            console.log(`  ⚠ UNKNOWN STATE  ${JSON.stringify(r.state)} / ${JSON.stringify(r.city)} — ${r.asm} (left as is)`);
            continue;
        }
        if (p.state === r.state && p.city === r.city) continue;
        changed++;
        console.log(`  ${JSON.stringify(r.state)} / ${JSON.stringify(r.city)}  →  ${JSON.stringify(p.state)} / ${JSON.stringify(p.city)} — ${r.asm}`);
        if (apply) {
            await db.execute(sql`
                UPDATE asm_territories SET state = ${p.state}, city = ${p.city}, updated_at = NOW()
                 WHERE territory_id::text = ${r.id}
            `);
        }
    }
    console.log(`\n${rows.length} territories, ${changed} to normalise, ${unknown} with an unknown state. ${apply ? "Written." : "Dry run — pass --apply to write."}`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
