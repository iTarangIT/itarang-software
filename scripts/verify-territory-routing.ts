// E-367 — what automatic ASM routing does (or would do) on this database.
//
//   node --import tsx --env-file=.env.local scripts/verify-territory-routing.ts [--days=7] [--city=Patna --state=Bihar]
//
// Read-only. Uses the real resolveLeadPlace / findTerritoryCandidates /
// rankCandidates / orderInTurn the live routing uses.
//
//   1. The switch, and whether lead_route_log (E-367) exists.
//   2. Every active ASM territory, and territories whose state is not in the
//      states master (they can never match a lead).
//   3. --city/--state: who a lead from that place would go to now.
//   4. Unowned leads the AI qualified or got a callback on in the last N days,
//      with the ASM each would go to (or "→ ISR" when nobody covers it).
//   5. With E-367: the last decisions by rule.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    findTerritoryCandidates,
    getTerritoryRoutingSettings,
    hasRouteLog,
    resolveLeadPlace,
} from "@/lib/ai-dialer/territoryRouting";
import { orderInTurn, rankCandidates } from "@/lib/ai-dialer/territoryRules";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
const arg = (k: string) => process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

async function who(raw: { state: string | null; city: string | null; location: string | null }, logged: boolean) {
    const place = await resolveLeadPlace(raw);
    if (!place.state) return { place, text: "→ ISR (no state on the lead)" };
    const { rule, tied } = rankCandidates(await findTerritoryCandidates(db, place, logged), place.cityKeys);
    const order = orderInTurn(tied);
    if (!rule || !order[0]) return { place, text: "→ ISR (no ASM covers it)" };
    const rest = order.length > 1 ? ` (then ${order.slice(1).map((c) => c.name).join(", ")})` : "";
    return { place, text: `→ ${order[0].name} [${rule === "territory_city" ? "city" : "state"}]${rest}` };
}

async function main() {
    const days = Number(arg("days") ?? 7);
    const settings = await getTerritoryRoutingSettings();
    const logged = await hasRouteLog();
    console.log(`Switch: ${settings.enabled ? "ON" : "OFF"}   lead_route_log (E-367): ${logged ? "present" : "MISSING"}\n`);

    const terr = rowsOf<{ asm: string; active: boolean; state: string; city: string | null; known_state: boolean | null }>(
        await db.execute(sql`
            SELECT COALESCE(u.name, u.email, t.asm_id) AS asm, COALESCE(u.is_active, false) AS active,
                   t.state, t.city,
                   (SELECT EXISTS (SELECT 1 FROM states s WHERE lower(s.name) = lower(trim(t.state)))) AS known_state
              FROM asm_territories t
              LEFT JOIN users u ON u.id::text = t.asm_id
             WHERE (t.active_to IS NULL OR t.active_to >= CURRENT_DATE)
             ORDER BY t.state, t.city NULLS FIRST, asm
        `),
    );
    console.log(`Active ASM territories: ${terr.length}`);
    for (const t of terr) {
        const flags = [!t.active ? "ASM INACTIVE" : "", t.known_state === false ? "UNKNOWN STATE — never matches" : ""]
            .filter(Boolean)
            .join(", ");
        console.log(`  ${t.state} / ${t.city ?? "(whole state)"} — ${t.asm}${flags ? `   ⚠ ${flags}` : ""}`);
    }

    const city = arg("city");
    const state = arg("state");
    if (city || state) {
        const r = await who({ state: state ?? null, city: city ?? null, location: null }, logged);
        console.log(`\nA lead from ${[city, state].filter(Boolean).join(", ")} (resolved ${r.place.city ?? "-"}, ${r.place.state ?? "-"}): ${r.text}`);
    }

    const leads = rowsOf<{ id: string; name: string | null; state: string | null; city: string | null; location: string | null; reason: string }>(
        await db.execute(sql`
            SELECT dl.id, COALESCE(dl.shop_name, dl.dealer_name, dl.phone) AS name,
                   dl.state, dl.city, dl.location, dl.sales_ready_reason AS reason
              FROM dealer_leads dl
             WHERE dl.sales_ready_reason IN ('ai_qualified', 'ai_callback')
               AND dl.sales_ready_at >= now() - make_interval(days => ${days})
             ORDER BY dl.sales_ready_at DESC
             LIMIT 200
        `),
    );
    console.log(`\nAI-qualified / callback leads, last ${days} days: ${leads.length} (who would get each now)`);
    const tally = new Map<string, number>();
    for (const l of leads) {
        const r = await who(l, logged);
        tally.set(r.text.startsWith("→ ISR") ? r.text : "→ an ASM", (tally.get(r.text.startsWith("→ ISR") ? r.text : "→ an ASM") ?? 0) + 1);
        console.log(`  ${(l.name ?? l.id).slice(0, 32).padEnd(32)} ${(`${r.place.city ?? "-"}, ${r.place.state ?? "-"}`).padEnd(28)} ${l.reason.padEnd(13)} ${r.text}`);
    }
    for (const [k, n] of tally) console.log(`  ${n} ${k}`);

    if (logged) {
        const byRule = rowsOf<{ rule: string; n: number }>(
            await db.execute(sql`
                SELECT rule, count(*)::int AS n FROM lead_route_log
                 WHERE created_at >= now() - make_interval(days => ${days})
                 GROUP BY rule ORDER BY n DESC
            `),
        );
        console.log(`\nRouting decisions, last ${days} days:`);
        for (const r of byRule) console.log(`  ${r.rule.padEnd(16)} ${r.n}`);
        if (byRule.length === 0) console.log("  none");
    }
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
