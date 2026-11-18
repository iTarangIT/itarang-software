// ID 243 (Rushikesh's lists) — the server-sorted lists accept each header sort, both
// ways, on the sandbox: the Leads list (rows, page 2, and the "select first N" ids)
// and Sales insight › Converted leads. Read-only. Refuses the live database (database-2).
//
//   node --import tsx --env-file=.env.local scripts/verify-table-sort-243-leads.ts
//
// Runs the real query builders (fetchLeadListRows / fetchLeadListIds,
// buildConvertedQuery) and checks the rows really come back in that order, blanks last.

import { db } from "@/lib/db";
import { fetchLeadListIds, fetchLeadListRows, type LeadListFilters, type LeadListRow } from "@/lib/leads/leadListQuery";
import { LEAD_LIST_SORT_KEYS, type LeadListSortKey } from "@/lib/leads/leadListSort";
import { buildConvertedQuery } from "@/lib/sales-insight/query";
import { CONVERTED_SORT_KEYS, type ConvertedSortKey } from "@/lib/sales-insight/types";
import { parseSortParam } from "@/lib/http/sortParam";

let failed = 0;
function check(ok: boolean, what: string) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failed++;
}

/** Non-blank values are in order and every blank comes after them (same rule as verify-table-sort-243.ts). */
function inOrder(values: unknown[], dir: "asc" | "desc"): boolean {
    const blank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");
    const firstBlank = values.findIndex(blank);
    if (firstBlank >= 0 && values.slice(firstBlank).some((v) => !blank(v))) return false;
    const vals = values.filter((v) => !blank(v)).map((v) =>
        v instanceof Date ? v.getTime() : typeof v === "number" ? v : typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9]/g, "") : v,
    ).filter((v) => v !== "") as Array<string | number>; // a non-Latin name (e.g. Devanagari) has no a-z to compare
    for (let i = 1; i < vals.length; i++) {
        const a = vals[i - 1];
        const b = vals[i];
        if (typeof a !== typeof b) continue;
        if (dir === "asc" ? a > b : a < b) return false;
    }
    return true;
}

const date = (v: unknown) => (v ? new Date(String(v)) : null);
const text = (v: unknown) => (v == null ? null : String(v).trim() || null);
const RANK: Record<string, number> = { hot: 3, warm: 2, cold: 1 };

const LEAD_COL: Record<LeadListSortKey, (r: LeadListRow) => unknown> = {
    dealer: (r) => text(r.dealer_name) ?? text(r.shop_name),
    city: (r) => text(r.city) ?? text(r.location),
    status: (r) => text(r.lead_status),
    interest: (r) => RANK[String(r.interest_level ?? "").toLowerCase()] ?? null,
    owner: (r) => text(r.current_owner_name),
    asm: (r) => text(r.asm_name),
    last_activity: (r) => date(r.last_touchpoint_at),
    idle: (r) => (r.idle_working_days == null ? null : Number(r.idle_working_days)),
    source: (r) => text(r.source),
    created: (r) => date(r.created_at),
};

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    if (host.startsWith("database-2")) throw new Error("refusing to run against live (database-2)");
    console.log(`DB host: ${host}\n`);

    // The unfiltered list as an admin sees it ("Hide dead & disqualified" on, as the page opens).
    const f = { hideDead: true } as LeadListFilters;

    // ── Leads list: every column, both ways ──
    for (const key of LEAD_LIST_SORT_KEYS) {
        for (const dir of ["asc", "desc"] as const) {
            const rows = await fetchLeadListRows(f, 1, 40, { key, dir });
            check(inOrder(rows.map(LEAD_COL[key]), dir), `Leads by ${key} ${dir} (${rows.length} rows)`);
        }
    }

    // ── Test case 1: Last activity, oldest first — page 2 carries on the same order ──
    const sort = { key: "last_activity" as const, dir: "asc" as const };
    const [p1, p2, both] = await Promise.all([
        fetchLeadListRows(f, 1, 20, sort),
        fetchLeadListRows(f, 2, 20, sort),
        fetchLeadListRows(f, 1, 40, sort),
    ]);
    check(
        [...p1, ...p2].map((r) => r.id).join() === both.map((r) => r.id).join(),
        `Leads last activity asc: page 1 + page 2 (20 each) = first 40 in one go`,
    );
    check(
        new Set([...p1, ...p2].map((r) => r.id)).size === p1.length + p2.length,
        `Leads last activity asc: no lead on both page 1 and page 2`,
    );

    // ── "Select first N" takes the ids in the table's order ──
    const ids = await fetchLeadListIds(f, 40, sort);
    check(ids.join() === both.map((r) => r.id).join(), `Leads select-first-N ids follow the table's sort`);

    // ── Default order unchanged when no sort is given ──
    const plain = await fetchLeadListRows(f, 1, 40);
    check(inOrder(plain.map((r) => date(r.last_touchpoint_at)), "desc"), `Leads with no sort: last activity newest first, as before`);

    // ── Unknown columns are never used ──
    check(parseSortParam(new URLSearchParams("sort=phone&dir=asc"), LEAD_LIST_SORT_KEYS) === null, "Leads: unknown sort column is ignored");

    // ── Sales insight › Converted leads ──
    const convCol: Record<ConvertedSortKey, (r: Record<string, unknown>) => unknown> = {
        source: (r) => text(r.source),
        name: (r) => text(r.display_name),
        region: (r) => text(r.region),
        dealer: (r) => text(r.dealer_id),
        converted: (r) => date(r.converted_at),
        intent: (r) => (r.intent_score == null ? null : Number(r.intent_score)),
    };
    for (const key of CONVERTED_SORT_KEYS) {
        for (const dir of ["asc", "desc"] as const) {
            const { rowsSql } = buildConvertedQuery({ page: 1, limit: 40, sort: { key, dir } });
            const rows = (await db.execute(rowsSql)) as unknown as Record<string, unknown>[];
            check(inOrder(rows.map(convCol[key]), dir), `Converted leads by ${key} ${dir} (${rows.length} rows)`);
        }
    }

    console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
}

main()
    .then(() => process.exit(failed ? 1 : 0))
    .catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    });
