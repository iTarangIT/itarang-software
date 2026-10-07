// Read-only check of the ID 46 leads-list number search against the live DB.
//
//   node --import tsx --env-file=.env.local scripts/verify-id46-number-search.ts
//
// Imports the real query builders (fetchLeadListRows / fetchNumberSearchMisses)
// and drives them with numbers taken from dealer_leads itself: one visible
// lead, one hidden by the default "Hide dead & disqualified" filter, one number
// no lead has, and one unreadable entry.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fetchLeadListIds, fetchLeadListRows, fetchNumberSearchMisses } from "@/lib/leads/leadListQuery";

const TEN = sql`right(regexp_replace(dl.phone, '[^0-9]', '', 'g'), 10)`;
const ABSENT = "6000000001";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function onePhone(where: ReturnType<typeof sql>): Promise<string | null> {
    const rows = (await db.execute<{ m: string }>(sql`
        SELECT ${TEN} AS m FROM dealer_leads dl
         WHERE dl.is_active IS NOT FALSE AND ${TEN} ~ '^[6-9][0-9]{9}$' AND ${where}
         LIMIT 1
    `)) as unknown as { m: string }[];
    return rows[0]?.m ?? null;
}

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}`);

    const visible = await onePhone(sql`
        (to_jsonb(dl) ->> 'contactability') IS NULL AND dl.current_status IS DISTINCT FROM 'disqualified'
        AND NOT EXISTS (
            SELECT 1 FROM dealer_leads o
             WHERE o.is_active IS NOT FALSE
               AND right(regexp_replace(o.phone, '[^0-9]', '', 'g'), 10) = ${TEN}
               AND ((to_jsonb(o) ->> 'contactability') IS NOT NULL OR o.current_status = 'disqualified'))`);
    // A number whose EVERY lead is hidden by the default filter.
    const hidden = await onePhone(sql`
        ((to_jsonb(dl) ->> 'contactability') IS NOT NULL OR dl.current_status = 'disqualified')
        AND NOT EXISTS (
            SELECT 1 FROM dealer_leads o
             WHERE o.is_active IS NOT FALSE
               AND right(regexp_replace(o.phone, '[^0-9]', '', 'g'), 10) = ${TEN}
               AND (to_jsonb(o) ->> 'contactability') IS NULL
               AND o.current_status IS DISTINCT FROM 'disqualified')`);
    const absentTaken = await onePhone(sql`${TEN} = ${ABSENT}`);
    console.log({ visible, hidden, absent: absentTaken ? "(in use — skipped)" : ABSENT });
    if (!visible) {
        console.log("No usable lead on this database — nothing to verify.");
        process.exit(1);
    }

    // Space-separated on purpose: the Excel-paste shape.
    const parts = [`+91 ${visible}`, hidden, absentTaken ? null : ABSENT].filter(Boolean).join(" ");
    const search = `${parts}, 12345`;
    console.log(`search = "${search}"`);
    const f = { search, hideDead: true };

    const rows = await fetchLeadListRows(f, 1, 50);
    const ten = (p: string | null) => (p ?? "").replace(/\D/g, "").slice(-10);
    check("rows are exactly the visible number's leads", rows.length > 0 && rows.every((r) => ten(r.phone) === visible), {
        rows: rows.length,
    });
    const ids = await fetchLeadListIds(f);
    check("ids_only agrees with the rows", ids.length === rows.length, { ids: ids.length });

    const misses = await fetchNumberSearchMisses(f);
    console.log("misses =", misses);
    check("invalid entry reported", misses?.invalid.join() === "12345");
    if (hidden) check("hidden lead reported as filtered_out", misses?.filtered_out.join() === hidden);
    else console.log("SKIP  no dead/disqualified-only number on this database");
    if (!absentTaken) check("absent number reported as not_found", misses?.not_found.join() === ABSENT);
    check("visible number is not a miss", !misses?.not_found.includes(visible) && !misses?.filtered_out.includes(visible));
    check("over_limit is 0", misses?.over_limit === 0);

    if (hidden) {
        const shown = await fetchNumberSearchMisses({ search, hideDead: false, contactability: "include" });
        check("with the filter off the hidden number matches", shown?.filtered_out.length === 0, shown);
    }

    // ID 45: a scoped rep must not learn that a pool number exists.
    const scoped = await fetchNumberSearchMisses({ search: visible, ownerScopeId: "00000000-0000-0000-0000-000000000000" });
    check("scoped viewer sees not_found, never filtered_out", scoped?.not_found.join() === visible && scoped.filtered_out.length === 0);

    check("text search still returns null misses", (await fetchNumberSearchMisses({ search: "Sharma" })) === null);

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
