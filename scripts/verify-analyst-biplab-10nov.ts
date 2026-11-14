// ID 250 item 3 — read-only: which of the AI Analyst's two answers on 10 Nov was wrong
// ("Biplab made 0 visits today", then "Biplabh Ghosh … 7 visited lead entries"). Runs the
// change list's query unchanged, plus the visit count the CRM itself uses (visited rows on
// the day, rule 185).
//
//   node --import tsx --env-file=.env.local scripts/verify-analyst-biplab-10nov.ts        # sandbox
//   node --import tsx --env-file=.env.production scripts/verify-analyst-biplab-10nov.ts   # live: the one to post
//
// Visited rows => the "0" was a failed name match. Only scheduled rows => 0 was right and
// the follow-up's "7" counted raw rows.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

const NAME = process.argv[2] ?? "biplab";
const DAY = process.argv[3] ?? "2026-11-10";

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`DB host: ${host || "(unset)"}  name ILIKE '%${NAME}%'  day ${DAY} (IST)\n`);

    const staff = (await db.execute(sql`
        SELECT name, role, is_active FROM analyst_staff WHERE name ILIKE ${`%${NAME}%`} ORDER BY name
    `)) as unknown as Array<{ name: string; role: string; is_active: boolean }>;
    console.log(`Staff matching: ${staff.length ? staff.map((s) => `${s.name} (${s.role}${s.is_active ? "" : ", inactive"})`).join(", ") : "none"}`);

    // The change list's query, as written.
    const rows = (await db.execute(sql`
        SELECT s.name, v.visit_status, v.actual_visit_date::text AS actual_visit_date, count(*)::int AS n
          FROM lead_visits v JOIN analyst_staff s ON s.user_id = v.asm_id
         WHERE s.name ILIKE ${`%${NAME}%`}
           AND (v.actual_visit_date = ${DAY}::date
                OR (v.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${DAY}::date)
         GROUP BY 1, 2, 3
         ORDER BY 1, 2, 3
    `)) as unknown as Array<{ name: string; visit_status: string; actual_visit_date: string | null; n: number }>;
    console.log("\nChange-list query (name, visit_status, actual_visit_date, count):");
    if (!rows.length) console.log("  (no rows)");
    for (const r of rows) console.log(`  ${r.name} | ${r.visit_status} | ${r.actual_visit_date ?? "—"} | ${r.n}`);

    const visited = rows.filter((r) => r.visit_status === "visited" && r.actual_visit_date === DAY).reduce((s, r) => s + r.n, 0);
    const other = rows.reduce((s, r) => s + r.n, 0) - visited;
    console.log(`\nVisits done on ${DAY} (visited rows dated that day): ${visited}`);
    console.log(`Other rows the query also returns (scheduled / created that day): ${other}`);
    console.log(
        visited > 0
            ? `=> The "0 visits" answer was the wrong one (a failed name match); ${visited} visit(s) were made.`
            : `=> No visit was done that day: "0" was right; the follow-up's number counted raw rows.`,
    );
    process.exit(0);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
