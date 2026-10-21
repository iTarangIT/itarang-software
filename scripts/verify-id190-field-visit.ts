/**
 * ID 190 — READ-ONLY: "Waiting for a field visit" adds up.
 *
 *   node --import tsx --env-file=.env.local      scripts/verify-id190-field-visit.ts [from] [to]
 *   node --import tsx --env-file=.env.production scripts/verify-id190-field-visit.ts
 *
 * For a period (default: the last 7 days to today, IST) and the 7 days before it:
 * 1. pending + new = visited + left + moved + waiting, and visited = of backlog
 *    + of new — per ASM, per team subtotal and in total;
 * 2. the drill lists (sales-drill fv_* kinds) have exactly the row counts of
 *    the cells — the total, and every ASM's row;
 * 3. a period ending today: still waiting = the Sales dashboard tile's count
 *    (salesHeadActions visit_overdue), past the limit = its past-the-limit rows,
 *    and = the daily email's Block D (loadAwaitingFieldVisit) total.
 * Exits 1 on any FAIL.
 */
export {};

const base = process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL = base + (base.includes("?") ? "&" : "?") + "default_transaction_read_only=on";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function main() {
    const { db } = await import("@/lib/db");
    const { fieldVisitPeriod, fieldVisitBalances, istToday, shiftDay } = await import("@/lib/dashboard/fieldVisitTrend");
    const { salesDrillRows, FV_DRILL_MEASURE } = await import("@/lib/dashboard/salesDrill");
    const { listSalesHeadAction } = await import("@/lib/dashboard/salesHeadActions");
    const { loadAwaitingFieldVisit } = await import("@/lib/digests/salesDailyBlocks");

    const today = istToday();
    const to = process.argv[3] ?? today;
    const from = process.argv[2] ?? shiftDay(to, -6);
    console.log(`DB host: ${new URL(base || "postgres://unset").host}  ·  ${from} → ${to}\n`);

    type Counts = Awaited<ReturnType<typeof fieldVisitPeriod>>["total"];
    const value: Record<string, (c: Counts) => number> = {
        pending: (c) => c.pending,
        new: (c) => c.new,
        visited: (c) => c.visited,
        visited_backlog: (c) => c.visitedBacklog,
        visited_new: (c) => c.visitedNew,
        left: (c) => c.left,
        moved: (c) => c.moved,
        waiting: (c) => c.waiting,
        past_limit: (c) => c.pastLimit,
    };

    for (const [pf, pt] of [
        [from, to],
        [shiftDay(from, -7), shiftDay(from, -1)],
    ]) {
        const p = await fieldVisitPeriod({}, pf, pt);
        const t = p.total;
        console.log(`── ${pf} → ${pt}: ${JSON.stringify(t)}`);
        check(`total balances: ${t.pending} + ${t.new} = ${t.visited} + ${t.left} + ${t.moved} + ${t.waiting}`, fieldVisitBalances(t));
        const bad = [...p.asms, ...p.teams].filter((r) => !fieldVisitBalances(r));
        check(`every ASM (${p.asms.length}) and team (${p.teams.length}) row balances`, bad.length === 0, bad.map((r) => r.name));

        // Drill lists = cells: the total for every measure, then every ASM's row.
        const f = { from: pf, to: pt };
        for (const [kind, measure] of Object.entries(FV_DRILL_MEASURE)) {
            const rows = await salesDrillRows(kind as never, f, { limit: 20000 });
            check(`drill ${kind}: ${rows.length} rows = cell ${value[measure!](t)}`, rows.length === value[measure!](t));
        }
        for (const r of p.asms) {
            const persons = [r.id ?? "__none__"];
            const [w, v, n] = await Promise.all([
                salesDrillRows("fv_waiting", f, { persons, limit: 20000 }),
                salesDrillRows("fv_visited", f, { persons, limit: 20000 }),
                salesDrillRows("fv_new", f, { persons, limit: 20000 }),
            ]);
            check(
                `${r.name}: drill waiting ${w.length}/${r.waiting}, visited ${v.length}/${r.visited}, new ${n.length}/${r.new}`,
                w.length === r.waiting && v.length === r.visited && n.length === r.new,
            );
        }
        console.log("");
    }

    // A period ending today against the tile and the email.
    const now = await fieldVisitPeriod({}, today, today);
    const tile = await listSalesHeadAction("visit_overdue", {});
    const past = tile.filter((r) => r.past_limit).length;
    check(`today: still waiting ${now.total.waiting} = tile ${tile.length}`, now.total.waiting === tile.length);
    check(`today: past the limit ${now.total.pastLimit} = tile past-limit rows ${past}`, now.total.pastLimit === past);
    const email = await loadAwaitingFieldVisit(db);
    const emailTotal = email ? [...email.values()].reduce((a, b) => a + b, 0) : -1;
    check(`email Block D total ${emailTotal} = tile ${tile.length}`, emailTotal === tile.length);

    console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
