// AI dialer list item 3 — read-only eyeball check of the spoken shop name
// against a real database. Writes nothing; safe on prod.
//
//   node --import tsx --env-file=.env.local scripts/verify-spoken-names.ts [--limit=200] [--recent]
//
// Prints raw title → spoken name for a sample of leads (random, or with
// --recent the leads most recently dialled by the AI), the rep overrides
// (E-378) if the table exists, and flags names that came out empty or that
// still look like a listing tail (over 3 words, "dealer", "near me", "|").

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { spokenShopName } from "@/lib/ai-dialer/spokenName";
import { hasSpokenNameTable } from "@/lib/ai-dialer/spokenNameStore";

const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 200);
const recent = process.argv.includes("--recent");

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

async function main() {
    const rows = rowsOf<{ id: string; shop_name: string }>(
        await db.execute(
            recent
                ? sql`SELECT dl.id, dl.shop_name FROM dealer_leads dl
                        JOIN dialer_campaign_leads cl ON cl.lead_id = dl.id
                       WHERE dl.shop_name <> ''
                       GROUP BY dl.id, dl.shop_name
                       ORDER BY max(cl.completed_at) DESC NULLS LAST
                       LIMIT ${limit}`
                : sql`SELECT id, shop_name FROM dealer_leads
                       WHERE shop_name <> '' ORDER BY random() LIMIT ${limit}`,
        ),
    );
    let suspicious = 0;
    for (const r of rows) {
        const spoken = spokenShopName(r.shop_name);
        const bad = !spoken || /\b(dealer|near me)\b|\|/i.test(spoken) || spoken.split(" ").length > 3;
        if (bad) suspicious++;
        console.log(`${bad ? "CHECK" : "     "}  ${r.shop_name.slice(0, 70).padEnd(70)} → ${spoken}`);
    }
    console.log(`\n${rows.length} leads, ${suspicious} to check by eye.`);

    if (await hasSpokenNameTable()) {
        const o = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM dealer_lead_spoken_names`))[0];
        console.log(`E-378 present: ${o?.n ?? 0} rep overrides.`);
    } else {
        console.log("E-378 not applied: every call uses the computed name; overrides cannot be saved.");
    }
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
