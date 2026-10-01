// ID 8 — "Same dashboard data at each employee level". Read-only.
//
//   node --import tsx --env-file=.env.local scripts/verify-role-dashboards.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//
// 1. Static: each rep route requires its own role and pins spoc_id to the
//    session (never reads it from the URL); each performance page requires
//    the matching role and renders the matching mode.
// 2. Live: builds the whole-team dashboard (section E present), picks the
//    busiest ASM and the busiest inside-sales rep, rebuilds the dashboard
//    pinned to each (what /asm/performance and /inside-sales/performance
//    show) and checks the pinned view has no section E and that its A–D
//    numbers equal that rep's row in the admin per-rep table.
//
// Exit 1 on any mismatch.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    buildSalesDashboard,
    type SalesDashboard,
    type SalesSpocBlock,
} from "@/lib/admin/salesDashboard";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
    if (!ok) failures++;
}

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8");

// ── 1. Static ────────────────────────────────────────────────────────────────

const VARIANTS = [
    {
        role: "asm",
        mode: "asm",
        route: "src/app/api/asm/reports/sales-dashboard/route.ts",
        page: "src/app/(dashboard)/asm/performance/page.tsx",
    },
    {
        role: "inside_sales_rep",
        mode: "isr",
        route: "src/app/api/inside-sales/reports/sales-dashboard/route.ts",
        page: "src/app/(dashboard)/inside-sales/performance/page.tsx",
    },
] as const;

console.log("── Static: routes and pages ──");
for (const v of VARIANTS) {
    const r = src(v.route);
    check(r.includes(`requireRole(["${v.role}"])`), `${v.route} requires only ${v.role}`);
    check(/spoc_id:\s*user\.id/.test(r), `${v.route} pins spoc_id to the session`);
    check(!/params\.spoc_id/.test(r), `${v.route} never reads spoc_id from the URL`);
    const p = src(v.page);
    check(p.includes(`requireRole(["${v.role}"])`), `${v.page} requires only ${v.role}`);
    check(p.includes(`mode="${v.mode}"`), `${v.page} renders mode="${v.mode}"`);
}
const admin = src("src/app/api/admin/reports/sales-dashboard/route.ts");
check(/params\.spoc_id/.test(admin), "admin route honours ?spoc_id (managers can drill into a rep)");

// ── 2. Live ──────────────────────────────────────────────────────────────────

type Comparable = Pick<SalesDashboard, "snapshot" | "totals" | "outcome" | "interest" | "averages">;

function pick(d: Comparable) {
    return {
        snapshot: d.snapshot,
        totals: d.totals,
        outcome: d.outcome,
        interest: d.interest.rows.map((r) => ({ level: r.interest_level, total: r.total })),
        averages: d.averages,
    };
}

function firstDiff(a: unknown, b: unknown, path = ""): string | null {
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
        return Object.is(a, b) ? null : `${path || "value"}: rep view ${JSON.stringify(a)} vs admin row ${JSON.stringify(b)}`;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        const d = firstDiff(
            (a as Record<string, unknown>)[k],
            (b as Record<string, unknown>)[k],
            path ? `${path}.${k}` : k,
        );
        if (d) return d;
    }
    return null;
}

async function main() {
    const from = arg("from") ?? null;
    const to = arg("to") ?? null;

    console.log("\n── Live: pinned rep view vs admin per-rep row ──");
    const team = await buildSalesDashboard({ from, to, granularity: "day" });
    console.log(`range ${team.filters.from} → ${team.filters.to}, ${team.per_spoc?.length ?? 0} reps in section E`);
    check(Array.isArray(team.per_spoc), "whole-team view carries section E");

    const busiest = (role: string): SalesSpocBlock | undefined =>
        (team.per_spoc ?? []).find(
            (b) => b.role === role && b.totals.visits + b.totals.calls > 0,
        );

    for (const v of VARIANTS) {
        const block = busiest(v.role);
        if (!block) {
            console.log(`SKIP  no ${v.role} with activity in range`);
            continue;
        }
        const pinned = await buildSalesDashboard({
            from,
            to,
            spoc_id: block.spoc_id,
            granularity: "day",
        });
        const who = `${v.role} ${block.name ?? block.spoc_id}`;
        check(pinned.per_spoc === null, `${who}: pinned view has no section E`);
        const diff = firstDiff(pick(pinned), pick(block));
        check(diff === null, `${who}: A–D equal the admin per-rep row`, diff ?? "");
    }

    console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
    process.exit(failures ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
