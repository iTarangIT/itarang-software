/**
 * Queue filters + CSV export — does the SQL actually run?
 *
 * The Inside Sales and ASM queues are hand-written `sql` templates, and a bad
 * fragment there fails at PARSE time: the whole workspace 500s rather than one
 * filter returning nothing. The unit tests cannot catch that (there is no
 * database in them) and neither can `tsc`, so this drives every tab of both
 * queues through every filter, against the live database, and reports what came
 * back.
 *
 *   node --import tsx --env-file=.env.local scripts/_verify-queue-filters.ts
 *
 * READ-ONLY. It only ever SELECTs, and it uses a real user id when it can find
 * one so the row counts mean something — but any id parses, so an empty result
 * is a pass, not a failure. What is being proved is that the statements are
 * valid and the filters compose, not that a particular rep has leads.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
    countAsmQueueRows,
    fetchAllAsmTabCounts,
    fetchAsmQueueRegions,
    fetchAsmQueueRows,
} from "@/lib/asm/queryBuilder";
import {
    countQueueRows,
    fetchAllTabCounts,
    fetchQueueRegions,
    fetchQueueRows,
} from "@/lib/inside-sales/queryBuilder";
import { ASM_QUEUE_TABS } from "@/lib/asm/types";
import { QUEUE_TABS } from "@/lib/inside-sales/types";
import { EMPTY_QUEUE_FILTERS } from "@/lib/leads/queueFilters";

const failures: string[] = [];

async function step(label: string, fn: () => Promise<unknown>) {
    try {
        const out = await fn();
        const n = Array.isArray(out) ? out.length : out;
        console.log(`  PASS  ${label} → ${JSON.stringify(n)}`);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.log(`  FAIL  ${label} → ${message}`);
        failures.push(`${label}: ${message}`);
    }
}

/** A real id if the database has one, so the counts are not all trivially zero. */
async function anyUserId(role: string): Promise<string> {
    const rows = (await db.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM users WHERE role = ${role} LIMIT 1
    `)) as unknown as { id: string }[];
    return rows[0]?.id ?? "00000000-0000-0000-0000-000000000000";
}

async function main() {
    const [{ host }] = (await db.execute<{ host: string }>(
        sql`SELECT inet_server_addr()::text AS host`,
    )) as unknown as { host: string }[];
    console.log(`Database: ${process.env.DATABASE_URL?.split("@")[1]?.split("/")[0] ?? host}\n`);

    // Every shared filter set at once. A filter that only parses in isolation is
    // not the failure mode worth testing — they all AND into one WHERE.
    const filters = {
        ...EMPTY_QUEUE_FILTERS,
        status: "Transferred_to_ASM",
        interest: "warm",
        state: "Haryana",
        city: "Panipat",
        from: "2026-01-01",
        to: "2026-12-31",
    };

    const isrId = await anyUserId("inside_sales_rep");
    console.log(`Inside Sales queue (user ${isrId}):`);
    for (const tab of QUEUE_TABS) {
        await step(`rows   ${tab}`, () =>
            fetchQueueRows({
                tab,
                userId: isrId,
                page: 1,
                limit: 5,
                q: "a",
                neodoveOnly: true,
                callbackOnly: true,
                filters,
            }),
        );
        await step(`count  ${tab}`, () =>
            countQueueRows({
                tab,
                userId: isrId,
                q: "a",
                neodoveOnly: true,
                callbackOnly: true,
                filters,
            }),
        );
        await step(`facets ${tab}`, () => fetchQueueRegions(isrId, tab));
    }
    await step("badges (all tabs, filtered)", () =>
        fetchAllTabCounts(isrId, { neodoveOnly: true, callbackOnly: true, filters }),
    );

    // Prefer an ASM who actually OWNS A LEAD WITH A VISIT, so the visit filters
    // and the visit-date range get exercised against real rows rather than
    // skipped. Falls back to any ASM, and then to a dummy id.
    const asmId = await (async () => {
        const rows = (await db.execute<{ id: string }>(sql`
            SELECT dl.current_owner_id AS id
              FROM lead_visits lv
              JOIN dealer_leads dl ON dl.id = lv.dealer_lead_id
             WHERE dl.current_owner_id IS NOT NULL
             ORDER BY COALESCE(lv.actual_visit_date, lv.scheduled_date) DESC NULLS LAST
             LIMIT 1
        `)) as unknown as { id: string }[];
        return rows[0]?.id ?? (await anyUserId("asm"));
    })();
    console.log(`\nASM queue (user ${asmId}):`);
    const asmExtra = { visitStatus: "scheduled", visitOutcome: "productive" };
    for (const tab of ASM_QUEUE_TABS) {
        await step(`rows   ${tab}`, () =>
            fetchAsmQueueRows({
                tab,
                asmId,
                page: 1,
                limit: 5,
                q: "a",
                filters,
                ...asmExtra,
            }),
        );
        await step(`count  ${tab}`, () =>
            countAsmQueueRows({ tab, asmId, q: "a", filters, ...asmExtra }),
        );
        await step(`facets ${tab}`, () => fetchAsmQueueRegions(asmId, tab));
    }
    await step("badges (all tabs, filtered)", () =>
        fetchAllAsmTabCounts(asmId, { filters, ...asmExtra }),
    );

    // Unfiltered too: the fragments are appended conditionally, so "no filters"
    // is a different statement from "all filters" and has its own way to break.
    console.log("\nUnfiltered (the shape every page load takes):");
    await step("ISR rows my_open", () =>
        fetchQueueRows({ tab: "my_open", userId: isrId, page: 1, limit: 5 }),
    );
    await step("ASM rows my_visits", () =>
        fetchAsmQueueRows({ tab: "my_visits", asmId, page: 1, limit: 5 }),
    );

    // ── Does a filter SELECT, or merely parse? ───────────────────────────
    // Take a real row off the ASM queue and filter by that row's own values.
    // A filter that parses but matches nothing would sail through everything
    // above; this is the check that says the WHERE means what it reads.
    console.log("\nSelectivity (filter a real row by its own values):");
    const pool = await fetchAsmQueueRows({
        tab: "my_visits",
        asmId,
        page: 1,
        limit: 50,
    });
    // Prefer a row that HAS a visit date: the date range is the filter most
    // likely to be subtly wrong (inclusive end, timestamp vs date), and it can
    // only be checked against a row that carries one.
    const sample =
        pool.find((r) => r.actual_visit_date || r.scheduled_date) ?? pool[0];
    if (!sample) {
        console.log("  SKIP  this ASM has no active visits to sample");
    } else {
        console.log(
            `  Sample: ${sample.dealer_name} — ${sample.state ?? "no state"} / ${sample.lead_status ?? "no status"} / ${sample.interest_level ?? "no interest"}`,
        );
        const hit = async (label: string, f: Record<string, string>) => {
            const rows = await fetchAsmQueueRows({
                tab: "my_visits",
                asmId,
                page: 1,
                limit: 50,
                filters: { ...EMPTY_QUEUE_FILTERS, ...f },
            });
            const found = rows.some((r) => r.id === sample.id);
            console.log(`  ${found ? "PASS" : "FAIL"}  ${label} still finds the sample`);
            if (!found) failures.push(`${label} did not select its own row`);
        };
        const miss = async (label: string, f: Record<string, string>) => {
            const rows = await fetchAsmQueueRows({
                tab: "my_visits",
                asmId,
                page: 1,
                limit: 50,
                filters: { ...EMPTY_QUEUE_FILTERS, ...f },
            });
            const found = rows.some((r) => r.id === sample.id);
            console.log(`  ${found ? "FAIL" : "PASS"}  ${label} excludes the sample`);
            if (found) failures.push(`${label} failed to exclude`);
        };

        if (sample.lead_status) await hit("status", { status: sample.lead_status });
        if (sample.state) await hit("state", { state: sample.state });
        if (sample.interest_level) {
            // Deliberately upper-cased: the column is free text and the filter
            // lower-cases both sides, so "WARM" must select a "warm" row.
            await hit("interest (case-insensitively)", {
                interest: sample.interest_level.toUpperCase(),
            });
        }
        await miss("a state the row is not in", { state: "__nowhere__" });

        // The two ASM-only filters, which read the lateral rather than
        // dealer_leads and so have their own way to be wrong.
        if (sample.visit_status) {
            const rows = await fetchAsmQueueRows({
                tab: "my_visits",
                asmId,
                page: 1,
                limit: 50,
                visitStatus: sample.visit_status,
            });
            const found = rows.some((r) => r.id === sample.id);
            console.log(
                `  ${found ? "PASS" : "FAIL"}  visit status "${sample.visit_status}" still finds the sample`,
            );
            if (!found) failures.push("visitStatus did not select its own row");
        }

        // The end of a date range is INCLUSIVE — a row dated on the boundary
        // must survive it. This is the assertion that catches a `<=` against a
        // timestamp silently dropping the last day.
        const on = (sample.actual_visit_date ?? sample.scheduled_date)?.slice(0, 10);
        if (on) await hit(`visit date range [${on}, ${on}]`, { from: on, to: on });
        else console.log("  SKIP  sample has no visit date to range over");
    }

    console.log(
        failures.length
            ? `\n${failures.length} FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`
            : "\nEvery queue statement parsed and ran.",
    );
    process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
