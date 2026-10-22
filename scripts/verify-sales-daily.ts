/**
 * READ-ONLY: does the Sales Daily email match the database?
 *
 *   node --import tsx --env-file=.env.production scripts/verify-sales-daily.ts [istDay]
 *
 * istDay is the day the mail COVERS (YYYY-MM-DD), default yesterday in IST. The
 * 4 Oct 2026 mail that was questioned is `2026-10-04`.
 *
 * For each window the email uses (Yesterday · Last 7 days · MTD · same period
 * last month) this builds Block A and the per-rep figures with the REAL modules
 * the digest calls (salesDailyPeriods → buildSalesDashboard → buildBlockA /
 * loadRepExtras), then recounts each figure with a separate plain query written
 * here — a different query, the same definition — and prints every pair. A
 * mismatch exits 1.
 *
 * Checked:
 *   Leads in                     = every lead created in the window, any source
 *                                  (ID 153), counted the way the /leads list's
 *                                  Created filter counts (leadListQuery.ts:
 *                                  UTC → IST date)
 *   Calls made / Dealers called  = inside_sales_call touchpoints on IST days
 *                                  (NeoDove re-dispositions printed apart: they
 *                                  are dropped by design, metricDefinitions.ts)
 *   Dealers visited              = distinct dealers with a visit dated in range
 *   Marked Won                   = distinct leads moved to Won
 *   Quotes delivered             = quote_dispatched touchpoints
 *   Per rep (MTD)                = calls per performed_by, visits per asm_id
 *   Sales Dashboard rows         = the Sales Dashboard page's own figures for the
 *                                  same from / to (calls, dealers, visits, quotes,
 *                                  converted, batteries, revenue, KYC)
 *   D · open leads per owner     = open (not Converted / Lost) active leads by
 *                                  current owner and Hot / Warm / Cold — the
 *                                  /leads Intent filter's rule
 *   Right now                    = the Ready to assign page's own list
 *
 * ID 194 — "My day" (one email per ISR / ASM):
 *
 *   node --import tsx --env-file=.env.local scripts/verify-sales-daily.ts [istDay] --my-day <email|name> [--render <file.html>]
 *
 *   builds the management email and that person's My day email for the same
 *   covered day and checks: their row in "My numbers" is their row in Block B
 *   / C, and every line of "My team" (members and the team subtotal) is a line
 *   of the management email. --render writes their email's HTML to a file.
 */
export {};

const base = process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL = base + (base.includes("?") ? "&" : "?") + "default_transaction_read_only=on";

type Win = { from: string; to: string };

function istYesterday(): string {
    const now = new Date(Date.now() + 5.5 * 3600_000);
    now.setUTCDate(now.getUTCDate() - 1);
    return now.toISOString().slice(0, 10);
}

/** ID 194 — a person's My day rows must be rows of the management email. */
async function verifyMyDay(istDay: string, who: string, renderTo: string | null) {
    const { salesDailyDigest } = await import("@/lib/digests/kinds/sales-daily");
    const { myDayDigest, collectMyDay } = await import("@/lib/digests/kinds/my-day");
    const people = await myDayDigest.perRecipient!.resolve({ roles: { inside_sales_rep: true, asm: true } });
    const q = who.toLowerCase();
    const person =
        people.find((p) => p.email.toLowerCase() === q || p.id === who) ??
        people.find((p) => p.name.toLowerCase().includes(q));
    if (!person) throw new Error(`no active ISR / ASM with an email matches "${who}"`);
    console.log(`My day for ${person.name} (${person.role}, ${person.email}) covering ${istDay}`);

    const [mgmt, mine] = await Promise.all([salesDailyDigest.collect(istDay), collectMyDay(istDay, person)]);
    if (!mgmt.ok) throw new Error(`management email failed: ${mgmt.error}`);
    if (!mine.ok) throw new Error(`My day failed: ${mine.error}`);
    const table = (f: typeof mine.figures, key: string) => (f.tables ?? []).filter((t) => t.key === key);
    const block = table(mgmt.figures, person.role === "asm" ? "block_b" : "block_c")[0];
    const mgmtRows = [...table(mgmt.figures, "block_b"), ...table(mgmt.figures, "block_c")].flatMap((t) => t.rows);
    const same = (a: Array<string | number>, b: Array<string | number>) => JSON.stringify(a) === JSON.stringify(b);
    let bad = 0;

    const [numbers, targets, work] = table(mine.figures, "my_numbers").concat(table(mine.figures, "work_list"));
    const own = numbers.rows[0];
    const theirs = block?.rows.find((r) => String(r[0]).replace(/^↳ /, "") === own?.[0]);
    if (!own) {
        console.log("  My numbers: no row (nothing recorded) — the management email must not list them either");
        if (block?.rows.some((r) => String(r[0]).replace(/^↳ /, "") === person.name)) bad++;
    } else {
        const ok = !!theirs && same(own.slice(1), theirs.slice(1));
        console.log(`  My numbers  ${ok ? "ok      " : "MISMATCH"}  ${own.join(" | ")}`);
        if (!ok) {
            console.log(`  management             ${theirs ? theirs.join(" | ") : "(not in the block)"}`);
            bad++;
        }
    }
    console.log(`  Targets to date: ${targets?.rows.length ?? 0} line(s)`);
    for (const r of targets?.rows ?? []) console.log(`    ${r.join(" | ")}`);
    console.log(`  Work list: ${work?.rows.length ?? 0} item(s), ${work?.rowLinks?.filter(Boolean).length ?? 0} linked`);

    for (const t of table(mine.figures, "my_team")) {
        console.log(`  ${t.title}`);
        for (const r of t.rows) {
            // A "Team total" exists only here (manager outside the block); every
            // other line must be printed in the management email.
            const ok = r[0] === "Team total" || mgmtRows.some((m) => same(m, r));
            if (!ok) bad++;
            console.log(`    ${ok ? "ok      " : "MISMATCH"}  ${r.join(" | ")}`);
        }
    }

    if (renderTo) {
        const { writeFileSync } = await import("node:fs");
        const { buildDigestEmail } = await import("@/lib/email/sendDigestEmail");
        const { html } = buildDigestEmail({ kind: myDayDigest, to: [person.email], slot: "morning", istDay, figures: mine.figures });
        writeFileSync(renderTo, html);
        console.log(`  rendered → ${renderTo}`);
    }
    console.log(bad === 0 ? "\nMy day reconciles with the management email." : `\n${bad} line(s) do not reconcile.`);
    process.exit(bad === 0 ? 0 : 1);
}

async function main() {
    const args = process.argv.slice(2);
    const flag = (name: string) => {
        const i = args.indexOf(name);
        return i >= 0 ? (args[i + 1] ?? "") : null;
    };
    const myDay = flag("--my-day");
    if (myDay != null) {
        if (!myDay) throw new Error("--my-day needs an email or a name");
        const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? istYesterday();
        return verifyMyDay(day, myDay, flag("--render"));
    }
    const { sql } = await import("drizzle-orm");
    const { db } = await import("@/lib/db");
    const { buildSalesDashboard } = await import("@/lib/admin/salesDashboard");
    const { buildBlockA } = await import("@/lib/digests/salesDailyBlockA");
    const { loadRepExtras } = await import("@/lib/digests/salesDailyBlocks");
    const { salesDailyPeriodsFor } = await import("@/lib/digests/kinds/sales-daily");

    const istDay = process.argv[2] ?? istYesterday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(istDay)) throw new Error("istDay must be YYYY-MM-DD");
    // ID 194: Yesterday = the last working day, exactly as the email counts it.
    const periods = await salesDailyPeriodsFor(istDay);
    console.log(`Sales Daily covering ${istDay}`);
    for (const [k, p] of Object.entries(periods)) console.log(`  ${k.padEnd(10)} ${p.from} → ${p.to}`);

    const dash = (p: Win) =>
        buildSalesDashboard({ ...p, city: null, state: null, spoc_id: null, business_type: null, granularity: "day" });
    const [dy, dp, dw, dm] = await Promise.all([
        dash(periods.yesterday),
        dash(periods.dayBefore),
        dash(periods.sameDayLastWeek),
        dash(periods.mtd),
    ]);
    const blockA = await buildBlockA(db, periods, { yesterday: dy, dayBefore: dp, sameDayLastWeek: dw, mtd: dm });
    const row = (label: string) => blockA.rows.find((r) => r.label === label)?.values;

    const one = async (q: ReturnType<typeof sql>): Promise<number> => {
        const r = (await db.execute(q)) as unknown as Array<{ n: string | number | null }>;
        return Number(r[0]?.n ?? 0);
    };
    const istDate = (col: ReturnType<typeof sql>) => sql`(${col} AT TIME ZONE 'Asia/Kolkata')::date`;

    // Independent recounts — written here, not imported.
    const independent: Record<string, (p: Win) => Promise<number>> = {
        "Leads in": (p) =>
            one(sql`SELECT COUNT(*) AS n FROM dealer_leads dl
                     WHERE dl.is_active IS NOT FALSE
                       AND (dl.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${p.from}::date AND ${p.to}::date`),
        "Calls made": (p) =>
            one(sql`SELECT COUNT(*) AS n FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                     WHERE t.touchpoint_type = 'inside_sales_call'
                       AND ${istDate(sql`t.performed_at`)} BETWEEN ${p.from}::date AND ${p.to}::date`),
        "Dealers visited": (p) =>
            one(sql`SELECT COUNT(DISTINCT v.dealer_lead_id) AS n FROM lead_visits v JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
                     WHERE v.actual_visit_date BETWEEN ${p.from}::date AND ${p.to}::date`),
        "Marked Won": (p) =>
            one(sql`SELECT COUNT(DISTINCT h.dealer_lead_id) AS n FROM dealer_lead_status_history h
                     WHERE h.to_status = 'Won' AND ${istDate(sql`h.changed_at`)} BETWEEN ${p.from}::date AND ${p.to}::date`),
        "Quotes delivered": (p) =>
            one(sql`SELECT COUNT(*) AS n FROM lead_touchpoints t
                     WHERE t.touchpoint_type = 'quote_dispatched'
                       AND ${istDate(sql`t.performed_at`)} BETWEEN ${p.from}::date AND ${p.to}::date`),
    };
    const emailValue: Record<string, (k: "y" | "prev" | "wk" | "mtd") => number | null> = {
        "Leads in": (k) => row("Leads in")?.[k] ?? null,
        "Calls made": (k) => row("Calls made")?.[k] ?? null,
        "Dealers visited": (k) => row("Dealers visited")?.[k] ?? null,
        "Marked Won": (k) => row("Marked Won")?.[k] ?? null,
        "Quotes delivered": (k) => row("Quotes delivered")?.[k] ?? null,
    };
    // Calls are deduped by design (NeoDove re-dispositions): the raw count may be
    // higher, never lower. Everything else must match exactly.
    const dedupedRows = new Set(["Calls made"]);

    const keys = [
        ["y", periods.yesterday],
        ["prev", periods.dayBefore],
        ["wk", periods.sameDayLastWeek],
        ["mtd", periods.mtd],
    ] as const;
    let bad = 0;
    console.log("\nBlock A — email vs independent recount");
    console.log(`  ${"metric".padEnd(30)} ${"window".padEnd(5)} ${"email".padStart(8)} ${"db".padStart(8)}`);
    for (const [name, recount] of Object.entries(independent)) {
        for (const [k, p] of keys) {
            const e = emailValue[name](k);
            const d = await recount(p);
            const ok = e != null && (dedupedRows.has(name) ? e <= d : e === d);
            if (!ok) bad++;
            const note = dedupedRows.has(name) && e != null && e < d ? `  (${d - e} NeoDove re-dispositions merged)` : "";
            console.log(`  ${name.padEnd(30)} ${k.padEnd(5)} ${String(e ?? "—").padStart(8)} ${String(d).padStart(8)} ${ok ? "ok" : "MISMATCH"}${note}`);
        }
    }
    const li = row("Leads in");
    console.log(`\n  Leads in (every source) y/day before/same day last week/MTD: ${li?.y}/${li?.prev}/${li?.wk}/${li?.mtd}`);

    // Per rep, MTD: the dashboard's per_spoc (Blocks B / C) vs plain counts.
    console.log("\nPer rep (MTD) — email vs independent recount");
    const names = new Map((dm.per_spoc ?? []).map((b) => [b.spoc_id, b.name ?? b.spoc_id]));
    const callsBy = (await db.execute(sql`
        SELECT t.performed_by AS u, COUNT(*) AS n FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
         WHERE t.touchpoint_type = 'inside_sales_call'
           AND ${istDate(sql`t.performed_at`)} BETWEEN ${periods.mtd.from}::date AND ${periods.mtd.to}::date
         GROUP BY 1`)) as unknown as Array<{ u: string | null; n: string }>;
    const visitsBy = (await db.execute(sql`
        SELECT v.asm_id AS u, COUNT(DISTINCT v.dealer_lead_id) AS n FROM lead_visits v JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
         WHERE v.actual_visit_date BETWEEN ${periods.mtd.from}::date AND ${periods.mtd.to}::date
         GROUP BY 1`)) as unknown as Array<{ u: string | null; n: string }>;
    const rawCalls = new Map(callsBy.map((r) => [r.u ?? "", Number(r.n)]));
    const rawVisits = new Map(visitsBy.map((r) => [r.u ?? "", Number(r.n)]));
    for (const b of dm.per_spoc ?? []) {
        const c = rawCalls.get(b.spoc_id) ?? 0;
        const v = rawVisits.get(b.spoc_id) ?? 0;
        const callsOk = b.totals.calls <= c && (c === 0 || b.totals.calls > 0);
        const visitsOk = b.totals.unique_visits === v;
        if (!callsOk || !visitsOk) bad++;
        if (b.totals.calls || c || b.totals.unique_visits || v) {
            console.log(
                `  ${String(names.get(b.spoc_id)).padEnd(22)} calls ${String(b.totals.calls).padStart(5)} / db ${String(c).padStart(5)}` +
                    `   dealers visited ${String(b.totals.unique_visits).padStart(4)} / db ${String(v).padStart(4)}` +
                    `${callsOk && visitsOk ? "" : "  MISMATCH"}`,
            );
        }
    }
    // Calls / visits by someone who is not a sales rep land on no row.
    for (const [u, n] of rawCalls) if (u && !names.has(u)) console.log(`  (not on the email) calls by ${u}: ${n}`);
    for (const [u, n] of rawVisits) if (u && !names.has(u)) console.log(`  (not on the email) visits by ${u}: ${n}`);

    const extras = await loadRepExtras(db, periods.mtd);
    console.log(`\n  Block C extras loaded for ${Object.keys(extras).length} metrics.`);

    // ID 188 — A2 · By person: each person's Yesterday / Day before / Same day
    // last week / MTD is the builder's per_spoc figure for that window, the
    // same people as Blocks B / C. Every cell must equal that day's per_spoc.
    {
        const { buildRepBlocks, byPersonRows } = await import("@/lib/digests/salesDailyBlocks");
        const extrasY = await loadRepExtras(db, periods.yesterday);
        const both = { y: extrasY, mtd: extras };
        const groups = (["asm", "inside_sales_rep"] as const).map((role) => ({
            role,
            blocks: buildRepBlocks(role, dy, dm, both, blockA.userTargets),
        }));
        const a2 = byPersonRows(groups, { prev: dp, wk: dw });
        console.log("\nA2 · By person — cells vs each window's per_spoc");
        const per = (d: typeof dm, id: string, role: string) => {
            const b = (d.per_spoc ?? []).find((x) => x.spoc_id === id);
            return b ? (role === "asm" ? b.totals.unique_visits : b.totals.calls) : 0;
        };
        for (const g of groups) {
            for (const b of g.blocks) {
                const line = a2.find((r) => r[0] === b.name);
                const want = [per(dy, b.id, g.role), per(dp, b.id, g.role), per(dw, b.id, g.role), per(dm, b.id, g.role)];
                const got = line?.slice(1, 5) ?? [];
                const ok = want.every((w, i) => got[i] === w);
                if (!ok) bad++;
                console.log(`  ${b.name.padEnd(26)} ${got.join(" / ")}${ok ? "" : `  MISMATCH per_spoc ${want.join(" / ")}`}`);
            }
        }
    }

    // Sales Dashboard page: the email's dashboard-sourced rows vs the page's own
    // numbers for the same window (the page calls buildSalesDashboard too —
    // this proves the email reads them and drops nothing on the way).
    console.log("\nBlock A vs the Sales Dashboard page, per window");
    const fromDash: Array<[string, (d: typeof dm) => number]> = [
        ["Calls made", (d) => d.totals.calls],
        ["Dealers called", (d) => d.totals.dealers_called],
        ["Dealers visited", (d) => d.totals.unique_visits],
        ["New dealers visited", (d) => d.totals.new_visits],
        ["Quotes created", (d) => d.outcome.quotes_issued],
        ["Converted", (d) => d.totals.converted],
        ["Batteries sold", (d) => d.outcome.batteries_to_dealers],
        ["Revenue", (d) => d.outcome.revenue],
        ["KYC submitted", (d) => d.outcome.kyc_submitted],
    ];
    const dashBy = { y: dy, prev: dp, wk: dw, mtd: dm } as const;
    for (const [label, get] of fromDash) {
        const cells = (["y", "prev", "wk", "mtd"] as const).map((k) => {
            const e = row(label)?.[k] ?? null;
            const d = get(dashBy[k]);
            const ok = e === d;
            if (!ok) bad++;
            return `${k}=${e ?? "—"}${ok ? "" : ` MISMATCH dashboard ${d}`}`;
        });
        console.log(`  ${label.padEnd(22)} ${cells.join("  ")}`);
    }

    // D · open Hot / Warm / Cold per owner, as of now.
    console.log("\nD · open leads per owner — email vs independent recount");
    const openBy = (await db.execute(sql`
        SELECT dl.current_owner_id AS u, dl.interest_level AS lvl, COUNT(*) AS n
          FROM dealer_leads dl
         WHERE dl.is_active IS NOT FALSE AND dl.current_owner_id IS NOT NULL
           AND dl.interest_level IN ('hot', 'warm', 'cold')
           AND COALESCE(dl.lead_status, '') NOT IN ('Converted', 'Lost')
         GROUP BY 1, 2`)) as unknown as Array<{ u: string; lvl: string; n: string }>;
    const open = new Map<string, number>();
    for (const r of openBy) open.set(`${r.u}|${r.lvl}`, Number(r.n));
    for (const b of dy.per_spoc ?? []) {
        const lv = (l: string) => b.interest.rows.find((x) => x.interest_level === l)?.total ?? 0;
        const parts = ["hot", "warm", "cold"].map((l) => {
            const e = lv(l);
            const d = open.get(`${b.spoc_id}|${l}`) ?? 0;
            if (e !== d) bad++;
            return `${l} ${e}${e === d ? "" : ` MISMATCH db ${d}`}`;
        });
        console.log(`  ${String(b.name ?? b.spoc_id).padEnd(22)} ${parts.join("  ")}`);
    }

    // Right now · sales-ready, no owner vs the Ready to assign page's list.
    const { countAwaitingAssignment, listReadyToAssign } = await import("@/lib/leads/salesReady");
    const [count, page] = await Promise.all([countAwaitingAssignment(), listReadyToAssign({ limit: 5000 })]);
    const pageOldest = page.reduce((m, r) => Math.max(m, Number(r.days_waiting)), 0);
    const rnOk = count.total === page.length && (page.length === 0 || count.oldestDays === pageOldest);
    if (!rnOk) bad++;
    console.log(
        `\nRight now · sales-ready, no owner: email ${count.total} (oldest ${count.oldestDays} days) · ` +
            `Ready to assign page ${page.length} (oldest ${pageOldest} days) ${rnOk ? "ok" : "MISMATCH"}`,
    );

    console.log(bad === 0 ? "\nAll figures reconcile." : `\n${bad} figure(s) do not reconcile.`);
    process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
