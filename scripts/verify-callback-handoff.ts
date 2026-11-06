// Read-only check of the AI callback hand-off against D8 (Priya KPI tracker
// task 11, 4 Nov 2026). Safe on production: SELECTs only.
//
//   node --import tsx --env-file=.env.local scripts/verify-callback-handoff.ts [--days=7]
//
// Each line is one D8 point, PASS / WARN / FAIL with the rows behind it:
//   1. owner set at once         — every sales callback has a person
//   2. not queued to the CEO     — no AI-callback lead sits on "Ready leads with no owner"
//   3. NeoDove push              — with the switch on, assigned ISR callbacks were pushed
//   4. 30-min escalation         — nothing overdue and silent without an escalation
//   5. after the third miss      — no open callback with 3+ unanswered pushes
//   6. no silent 11:00           — time-not-set callbacks are flagged (E-375)
//   7. ISR metric                — promised callbacks made within 30 min, per owner
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { getCallbackLoopSettings } from "../src/lib/ai-dialer/callbackLoop";
import { callbackOnTimeByOwner } from "../src/lib/ai-dialer/callbackMetrics";

const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=7").split("=")[1]) || 7;
const rowsOf = <T,>(r: unknown) => (Array.isArray(r) ? (r as T[]) : ((r as { rows: T[] }).rows ?? []));
let fails = 0;
const line = (status: "PASS" | "WARN" | "FAIL", name: string, detail: string) => {
    if (status === "FAIL") fails++;
    console.log(`${status.padEnd(4)}  ${name} — ${detail}`);
};

async function main() {
    console.log(`DB ${new URL(process.env.DATABASE_URL!).host.split(".")[0]}, last ${days} days\n`);
    const cols = rowsOf<{ c: string }>(
        await db.execute(sql`SELECT column_name AS c FROM information_schema.columns
                              WHERE table_schema = 'public' AND table_name = 'lead_callbacks'`),
    ).map((r) => r.c);
    if (!cols.includes("kind")) {
        line("FAIL", "E-362", "lead_callbacks has no loop columns — the callback loop is off on this DB");
        return;
    }
    const since = sql`now() - make_interval(days => ${days})`;
    const settings = await getCallbackLoopSettings();
    console.log(`callback owners: ${settings.ownerIds.length} · NeoDove push: ${settings.neodovePush ? "ON" : "off"}\n`);

    const unowned = rowsOf<{ id: string; lead_id: string; created_at: string }>(
        await db.execute(sql`
            SELECT id, lead_id, created_at::text FROM lead_callbacks
             WHERE owner_type = 'sales' AND assigned_user_id IS NULL AND created_at > ${since}
             ORDER BY created_at DESC LIMIT 20`),
    );
    line(unowned.length ? "FAIL" : "PASS", "1. owner set at once", unowned.length ? `${unowned.length} sales callbacks with no person, e.g. ${unowned.slice(0, 3).map((r) => r.lead_id).join(", ")}` : "every sales callback has a person");

    const queued = rowsOf<{ n: number }>(
        await db.execute(sql`
            SELECT count(*)::int AS n FROM dealer_leads dl
             WHERE dl.current_owner_id IS NULL AND dl.sales_ready_reason = 'ai_callback'
               AND dl.sales_ready_at > ${since}
               AND COALESCE(dl.lead_status, '') NOT IN ('Won', 'Converted', 'Lost')`),
    )[0].n;
    line(queued ? "FAIL" : "PASS", "2. not queued to the CEO card", queued ? `${queued} AI-callback leads still have no owner` : "none waiting on Ready leads with no owner");

    const unpushed = rowsOf<{ n: number }>(
        await db.execute(sql`
            SELECT count(*)::int AS n FROM lead_callbacks lc
              JOIN users u ON u.id::text = lc.assigned_user_id
             WHERE lc.owner_type = 'sales' AND lc.created_at > ${since}
               AND lower(u.role) <> 'asm' AND lc.neodove_pushed_at IS NULL`),
    )[0].n;
    line(
        !settings.neodovePush ? "WARN" : unpushed ? "FAIL" : "PASS",
        "3. pushed to the ISR in NeoDove",
        !settings.neodovePush ? `switch is OFF (${unpushed} ISR callbacks not pushed) — turn on in Settings › AI callbacks after the NeoDove test` : `${unpushed} ISR callbacks not pushed`,
    );

    const silent = rowsOf<{ n: number }>(
        await db.execute(sql`
            SELECT count(*)::int AS n FROM lead_callbacks lc
             WHERE lc.owner_type = 'sales' AND lc.status = 'open' AND lc.assigned_user_id IS NOT NULL
               AND lc.due_at < now() - interval '35 minutes' AND lc.escalated_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM lead_touchpoints t
                                WHERE t.dealer_lead_id = lc.lead_id
                                  AND t.touchpoint_type IN ('inside_sales_call', 'visit')
                                  AND t.performed_at >= lc.due_at - interval '15 minutes')`),
    )[0].n;
    line(silent ? "FAIL" : "PASS", "4. 30-min escalation to the Sales Head", silent ? `${silent} overdue callbacks with no call and no escalation (is the callback-loop ticker running?)` : "every overdue, uncalled callback was escalated");

    const missed3 = rowsOf<{ n: number }>(
        await db.execute(sql`SELECT count(*)::int AS n FROM lead_callbacks
                              WHERE status IN ('open', 'dialing') AND push_attempts >= 3`),
    )[0].n;
    const expired3 = rowsOf<{ n: number }>(
        await db.execute(sql`SELECT count(*)::int AS n FROM lead_callbacks
                              WHERE status = 'expired' AND completion_note LIKE 'Not reached after%' AND updated_at > ${since}`),
    )[0].n;
    line(missed3 ? "FAIL" : "PASS", "5. after the third miss", `${missed3} still open with 3+ misses; ${expired3} closed as "Not reached" (owner kept, follow-up in 3 working days)`);

    if (cols.includes("time_not_set")) {
        const flagged = rowsOf<{ flagged: number; total: number }>(
            await db.execute(sql`
                SELECT count(*) FILTER (WHERE time_not_set)::int AS flagged, count(*)::int AS total
                  FROM lead_callbacks WHERE owner_type = 'sales' AND created_at > ${since}`),
        )[0];
        line("PASS", "6. no silent 11:00", `${flagged.flagged} of ${flagged.total} sales callbacks flagged "Time not set"`);
    } else {
        line("WARN", "6. no silent 11:00", "E-375 not applied: the flag lives only in the brief");
    }

    const toDay = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const fromDay = new Date(Date.now() + 330 * 60_000 - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const onTime = await callbackOnTimeByOwner({ fromIstDay: fromDay, toIstDay: toDay });
    console.log(`\n7. ISR metric — promised callbacks made within 30 min (${fromDay} … ${toDay})`);
    if (onTime.length === 0) console.log("   no callback fell due");
    for (const r of onTime) console.log(`   ${(r.name ?? r.userId).padEnd(24)} ${String(r.onTime).padStart(3)} / ${String(r.due).padStart(3)}  ${r.pct == null ? "—" : `${r.pct}%`}`);
}

main()
    .catch((e) => {
        fails++;
        console.error(e);
    })
    .finally(() => {
        console.log(`\n${fails ? `${fails} FAIL` : "no FAIL"}`);
        process.exit(fails ? 1 : 0);
    });
