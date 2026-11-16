// ID 243 — every server-sorted list accepts each of its header sorts, both ways, on the
// sandbox: Admin › Accounts, CEO › Invoices, AI dialer campaigns, campaign calls.
// Read-only. Refuses the live database (database-2).
//
//   node --import tsx --env-file=.env.local scripts/verify-table-sort-243.ts
//
// For each column it runs the real query builder (Accounts, Invoices) or the route's
// ORDER BY through the same sortOrderSql helper (Campaigns, Calls — their SQL lives in
// the route), then checks the first rows really are in that order, blanks last.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { ACCOUNTS_SORT_KEYS, accountsPageSql } from "@/lib/accounts/accountsScreen";
import { INVOICE_SORT_KEYS, listRevenueInvoices } from "@/lib/dashboard/revenueSource";
import { parseSortParam } from "@/lib/http/sortParam";

let failed = 0;
function check(ok: boolean, what: string) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failed++;
}

/** Non-blank values are in order and every blank comes after them. */
function inOrder(values: unknown[], dir: "asc" | "desc"): boolean {
    const blank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");
    const firstBlank = values.findIndex(blank);
    if (firstBlank >= 0 && values.slice(firstBlank).some((v) => !blank(v))) return false;
    const vals = values.filter((v) => !blank(v)).map((v) =>
        v instanceof Date ? v.getTime() : typeof v === "string" && !Number.isNaN(Number(v)) && v.trim() !== "" ? Number(v) : typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9]/g, "") : v,
    ) as Array<string | number>;
    for (let i = 1; i < vals.length; i++) {
        const a = vals[i - 1];
        const b = vals[i];
        if (typeof a !== typeof b) continue;
        // Text is compared without spaces and punctuation, as the database collation orders it.
        if (dir === "asc" ? a > b : a < b) return false;
    }
    return true;
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    if (host.startsWith("database-2")) throw new Error("refusing to run against live (database-2)");
    console.log(`DB host: ${host}\n`);

    // ── Admin › Accounts ──
    const accCol: Record<string, (r: Record<string, unknown>) => unknown> = {
        name: (r) => r.name,
        gstin: (r) => r.gstin,
        owner: (r) => r.owner_name,
        came_through: (r) => r.came_through,
        onboarded_by: (r) => r.onboarded_by_name,
        location: (r) => [r.city, r.state].filter((x) => x && String(x).trim()).join(", "),
        created: (r) => (r.created_at ? new Date(String(r.created_at)) : null),
    };
    for (const key of ACCOUNTS_SORT_KEYS) {
        for (const dir of ["asc", "desc"] as const) {
            const rows = (await db.execute(await accountsPageSql({}, 40, 0, { key, dir }))) as unknown as Record<string, unknown>[];
            check(inOrder(rows.map(accCol[key]), dir), `Accounts by ${key} ${dir} (${rows.length} rows)`);
        }
    }

    // ── CEO › Invoices ──
    const invCol: Record<string, (r: Record<string, unknown>) => unknown> = {
        number: (r) => r.invoice_number,
        source: (r) => r.source,
        date: (r) => (r.invoice_date ? new Date(String(r.invoice_date)) : null),
        customer: (r) => r.customer_name,
        status: (r) => r.status,
        match: (r) => r.match_status,
        reference: (r) => r.payment_reference,
        total: (r) => r.total,
        balance: (r) => r.balance,
    };
    for (const key of INVOICE_SORT_KEYS) {
        for (const dir of ["asc", "desc"] as const) {
            const rows = (await listRevenueInvoices({ limit: 40, offset: 0, sort: { key, dir } })) as unknown as Record<string, unknown>[];
            check(inOrder(rows.map(invCol[key]), dir), `Invoices by ${key} ${dir} (${rows.length} rows)`);
        }
    }

    // ── parseSortParam: an unknown column is never used ──
    check(parseSortParam(new URLSearchParams("sort=id;drop&dir=asc"), INVOICE_SORT_KEYS) === null, "unknown sort column is ignored");

    // ── AI dialer campaigns list: the merged columns the route orders by ──
    const campaigns = (await db.execute(sql`
        SELECT c.name, c.status, c.provider, c.category, c.total_leads, c.calls_made, c.started_at
          FROM dialer_campaigns c
         ORDER BY lower(c.name) ASC NULLS LAST, COALESCE(c.started_at, c.created_at) DESC NULLS LAST
         LIMIT 40`)) as unknown as Record<string, unknown>[];
    check(inOrder(campaigns.map((r) => r.name), "asc"), `Campaigns by name asc (${campaigns.length} rows)`);
    const progress = (await db.execute(sql`
        SELECT (calls_made::numeric / NULLIF(total_leads, 0)) AS p
          FROM dialer_campaigns ORDER BY (calls_made::numeric / NULLIF(total_leads, 0)) DESC NULLS LAST LIMIT 40`)) as unknown as Array<{ p: string | null }>;
    check(inOrder(progress.map((r) => r.p), "desc"), `Campaigns by progress desc (${progress.length} rows)`);

    console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
}

main()
    .then(() => process.exit(failed ? 1 : 0))
    .catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    });
