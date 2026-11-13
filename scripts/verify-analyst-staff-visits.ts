// AI Analyst (13 Nov) — read-only ground truth for a "how many visits did <name> do?" answer.
// Writes nothing; safe on prod.
//
//   node --import tsx --env-file=.env.local scripts/verify-analyst-staff-visits.ts ["Biplabh Ghosh"]
//
// 1. Matches the name in users the way the analyst's staff rule says (every word, ILIKE,
//    partial spelling): prints every match, or says no one matches (the analyst must then say
//    so too, never "0 visits").
// 2. For each match, counts Visits by the agreed rule (metricDefinitions.ts ANALYST_RULES,
//    "Visits = lead_visits with visit_status 'visited', one per (asm_id, dealer_lead_id,
//    actual_visit_date)") for today (IST), this month (IST) and all time, plus Fresh / Repeat.
//
// Compare these with the analyst's answer to the same question on the same database.

import { sql } from "drizzle-orm";

import { staffNamePatterns } from "@/lib/analyst/staffMatch";
import { db } from "@/lib/db";

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

const asked = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "Biplabh Ghosh";

async function main() {
    const patterns = staffNamePatterns(asked);
    if (patterns.length === 0) throw new Error(`no usable words in "${asked}"`);
    const where = sql.join(
        patterns.map((p) => sql`u.name ILIKE ${p}`),
        sql` AND `,
    );
    const people = rowsOf<{ id: string; name: string; role: string; is_active: boolean | null }>(
        await db.execute(sql`SELECT u.id::text AS id, u.name, u.role, u.is_active FROM users u WHERE ${where} ORDER BY u.name`),
    );

    console.log(`Asked: "${asked}"  patterns: ${patterns.join(" AND ")}`);
    if (people.length === 0) {
        // The closest names, so the "no staff member matches" answer can be checked too.
        const first = patterns[0];
        const near = rowsOf<{ name: string }>(
            await db.execute(sql`SELECT name FROM users WHERE name ILIKE ${first} ORDER BY name LIMIT 5`),
        );
        console.log("No staff member matches. The analyst must say so, not answer 0.");
        console.log("Closest on the first word:", near.map((n) => n.name).join(", ") || "(none)");
        return;
    }
    if (people.length > 1) console.log(`${people.length} people match: the analyst should ask which one.`);

    for (const p of people) {
        const [c] = rowsOf<{
            today: number;
            month: number;
            all_time: number;
            fresh_month: number;
        }>(
            await db.execute(sql`
                WITH v AS (
                    SELECT DISTINCT asm_id, dealer_lead_id, actual_visit_date
                      FROM lead_visits
                     WHERE visit_status = 'visited' AND asm_id = ${p.id} AND actual_visit_date IS NOT NULL
                ),
                firsts AS (
                    SELECT dealer_lead_id, MIN(actual_visit_date) AS first_day FROM v GROUP BY dealer_lead_id
                ),
                bounds AS (
                    SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS today,
                           date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date AS month_start
                )
                SELECT
                    count(*) FILTER (WHERE v.actual_visit_date = b.today)::int AS today,
                    count(*) FILTER (WHERE v.actual_visit_date >= b.month_start AND v.actual_visit_date <= b.today)::int AS month,
                    count(*)::int AS all_time,
                    count(*) FILTER (WHERE v.actual_visit_date >= b.month_start AND v.actual_visit_date <= b.today
                                       AND v.actual_visit_date = f.first_day)::int AS fresh_month
                  FROM v CROSS JOIN bounds b JOIN firsts f USING (dealer_lead_id)
            `),
        );
        console.log(
            `\n${p.name} (${p.role}${p.is_active === false ? ", inactive" : ""}) id ${p.id.slice(0, 8)}…\n` +
                `  Visits today (IST): ${c.today}\n` +
                `  Visits this month (IST): ${c.month}  (Fresh ${c.fresh_month}, Repeat ${c.month - c.fresh_month})\n` +
                `  Visits all time: ${c.all_time}`,
        );
    }
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    });
