// Read-only check for B3 (ASM claim from territory pool).
//
// Runs the REAL ASM query builder for the new "unclaimed" tab against every
// ASM that has a territory row, so the SQL is exercised exactly as the route
// would run it, and reports how many claimable leads each ASM would see.
//
//   node --import tsx --env-file=.env.local scripts/verify-b3-asm-claim.ts

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fetchAllAsmTabCounts, fetchAsmQueueIds, fetchAsmQueueRows } from "@/lib/asm/queryBuilder";
import { BULK_CLAIM_CAP, CLAIM_ROLES } from "@/lib/inside-sales/types";

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);
    console.log(`CLAIM_ROLES: ${CLAIM_ROLES.join(", ")}  (cap ${BULK_CLAIM_CAP})`);

    const territories = await db.execute<{ asm_id: string; name: string | null; role: string | null; n: string }>(sql`
        SELECT t.asm_id, u.name, u.role, COUNT(*)::text AS n
        FROM asm_territories t
        LEFT JOIN users u ON u.id::text = t.asm_id
        GROUP BY t.asm_id, u.name, u.role
        ORDER BY u.name
    `);
    console.log(`asm_territories: ${territories.length} ASM(s) with territory rows`);

    const pool = await db.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n FROM dealer_leads
        WHERE current_owner_id IS NULL
          AND lead_status IS DISTINCT FROM 'Converted' AND lead_status IS DISTINCT FROM 'Lost'
          AND is_active IS NOT FALSE
    `);
    console.log(`unowned, open leads overall: ${pool[0]?.n}`);

    for (const t of territories) {
        const counts = await fetchAllAsmTabCounts(t.asm_id);
        const rows = await fetchAsmQueueRows({ tab: "unclaimed", asmId: t.asm_id, page: 1, limit: 3 });
        const ids = await fetchAsmQueueIds({ tab: "unclaimed", asmId: t.asm_id, limit: 5 });
        const owned = rows.filter((r) => r.current_owner_id).length;
        console.log(
            `- ${t.name ?? t.asm_id} [${t.role}] territories=${t.n} ` +
                `unclaimed=${counts.unclaimed} territory=${counts.territory} my_visits=${counts.my_visits} ` +
                `sample=${rows.map((r) => `${r.city}/${r.state}`).join(" | ") || "—"} ` +
                `ids_only=${ids.length}${owned ? `  !! ${owned} OWNED ROW(S) LEAKED` : ""}`,
        );
    }
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
