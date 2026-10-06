/**
 * READ-ONLY: do the sales dashboard's Per SPOC rows + the Unassigned row add up
 * to the whole-team figures, for every column the table shows? And is the
 * battery figure honest about invoices without item lines?
 *
 *   node --import tsx --env-file=.env.production scripts/verify-sales-dashboard-sums.ts [from] [to]
 */
export {};

const base = process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL = base + (base.includes("?") ? "&" : "?") + "default_transaction_read_only=on";

async function main() {
    const { buildSalesDashboard } = await import("@/lib/admin/salesDashboard");
    const { batteryReading } = await import("@/lib/admin/batteryReading");
    const [from, to] = process.argv.slice(2);
    const d = await buildSalesDashboard({
        from: from ?? null, to: to ?? null, city: null, state: null, spoc_id: null, business_type: null, granularity: "day",
    });
    console.log(`window ${d.filters.from} → ${d.filters.to}`);
    const blocks = [...(d.per_spoc ?? []), ...(d.unassigned ? [d.unassigned] : [])];
    const lvl = (b: (typeof blocks)[number], l: string) => b.interest.rows.find((r) => r.interest_level === l)?.total ?? 0;
    const cols: [string, (b: (typeof blocks)[number]) => number][] = [
        ["visits", (b) => b.totals.visits],
        ["new_visits", (b) => b.totals.new_visits],
        ["calls", (b) => b.totals.calls],
        ["hot", (b) => lvl(b, "hot")],
        ["warm", (b) => lvl(b, "warm")],
        ["cold", (b) => lvl(b, "cold")],
        ["converted", (b) => b.totals.converted],
        ["quotes_issued", (b) => b.outcome.quotes_issued],
        ["batteries", (b) => b.outcome.batteries_to_dealers],
        ["revenue", (b) => Math.round(b.outcome.revenue)],
        ["kyc", (b) => b.outcome.kyc_submitted],
        ["visits_yesterday", (b) => b.snapshot.visits_yesterday],
        ["calls_yesterday", (b) => b.snapshot.calls_yesterday],
    ];
    const whole = { ...d, per_spoc: undefined } as unknown as (typeof blocks)[number];
    let bad = 0;
    for (const [name, get] of cols) {
        const sum = blocks.reduce((s, b) => s + get(b), 0);
        const top = get(whole);
        const ok = sum === top;
        if (!ok) bad++;
        console.log(`${ok ? "✔" : "✘"} ${name.padEnd(17)} top=${top}  rows+unassigned=${sum}  unassigned=${d.unassigned ? get(d.unassigned) : 0}`);
    }
    console.log("\nbattery reading (top):", batteryReading(d.outcome));
    console.log("unique per rep (not additive across reps):", (d.per_spoc ?? []).map((b) => `${b.name}=${b.totals.unique_visits}`).join(" "));
    console.log(bad ? `\n${bad} column(s) do not add up` : "\nEvery column adds up.");
    process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e?.cause ?? e); process.exit(1); });
