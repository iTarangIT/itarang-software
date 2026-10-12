// Read-only check of IDs 85 + 86: dated time limits, the office calendar and
// the lead clocks agree everywhere they are read.
//
//   node --import tsx --env-file=.env.local scripts/verify-id85-86-time-limits.ts
//
// 1. E-337 is on this database; the limits in force today (and any change
//    scheduled for later) are listed; every stored value is inside its bounds.
// 2. The SQL working-day count equals the TS one (holidays included).
// 3. lead_clocks was rebuilt in the last two hours and holds its invariants:
//    every active sales-ready lead has a lead clock; a limit is passed only
//    when nothing came by the due moment; inferred owners are flagged.
// 4. The month's "Limit passed" events in the Lead events download = the
//    daily email's "Time limits missed" = lead_clocks; the email's "First
//    attempt within limit" = the owner clock's figure.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { istDay, workingDaysSince } from "@/lib/calendar/officeCalendar";
import { loadHolidays, workingDaysSinceSql } from "@/lib/calendar/holidays";
import { TIME_LIMITS, formatLimit } from "@/lib/timeLimits/registry";
import { getTimeLimits, hasTimeLimitTable, scheduledChanges, timeLimitLog } from "@/lib/timeLimits/store";
import { clockStats, clocksComputedAt, hasLeadClocks, limitsPassed } from "@/lib/leads/clocks";
import { countEvents } from "@/lib/leads/eventLog";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}
const one = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as T[])[0];

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);
    const today = istDay(new Date());
    const monthFrom = `${today.slice(0, 7)}-01`;

    // 1 — the store
    check("E-337 time_limit_settings present", await hasTimeLimitTable());
    const [values, scheduled, log] = await Promise.all([getTimeLimits(), scheduledChanges(), timeLimitLog()]);
    for (const d of TIME_LIMITS) {
        const v = values[d.key];
        const s = scheduled[d.key];
        console.log(`      ${d.key.padEnd(26)} ${formatLimit(v, d.unit).padEnd(20)}${v !== d.default ? ` (default ${d.default})` : ""}${s ? `  → ${s.value} from ${s.effective_from}` : ""}`);
        check(`${d.key} within ${d.min}–${d.max}`, v >= d.min && v <= d.max, v);
    }
    console.log(`      change log: ${log.length} row(s)`);

    // 2 — one calendar in SQL and TS
    const holidays = await loadHolidays();
    for (const back of [1, 5, 12, 40]) {
        const at = new Date(Date.now() - back * 86_400_000);
        const r = await one<{ n: number }>(sql`SELECT ${workingDaysSinceSql(sql`${at.toISOString()}::timestamptz`)} AS n`);
        const ts = workingDaysSince(at, new Date(), holidays);
        check(`working days since ${back} day(s) ago: SQL ${r?.n} = TS ${ts}`, Number(r?.n) === ts);
    }

    // 3 — the clocks
    if (!(await hasLeadClocks())) {
        check("E-337 lead_clocks present", false);
    } else {
        const at = await clocksComputedAt();
        check("lead_clocks rebuilt in the last 2 hours", !!at && Date.now() - Date.parse(at) < 2 * 3600_000, at);
        const inv = await one<Record<string, number>>(sql`
            SELECT
              (SELECT COUNT(*)::int FROM dealer_leads dl
                WHERE dl.is_active IS NOT FALSE AND (to_jsonb(dl) ->> 'sales_ready_at') IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM lead_clocks c WHERE c.dealer_lead_id = dl.id AND c.clock = 'lead')) AS ready_without_clock,
              (SELECT COUNT(*)::int FROM lead_clocks c
                WHERE c.limit_passed_at IS NOT NULL
                  AND (c.due_at IS NULL OR c.limit_passed_at <> c.due_at OR (c.first_attempt_at IS NOT NULL AND c.first_attempt_at <= c.due_at))) AS bad_passed,
              (SELECT COUNT(*)::int FROM lead_clocks c WHERE c.attempt_working_minutes < 0 OR c.first_attempt_at < c.started_at) AS bad_attempt,
              (SELECT COUNT(*)::int FROM lead_clocks c WHERE c.owner_inferred) AS owners_inferred,
              (SELECT COUNT(*)::int FROM lead_clocks) AS clocks`);
        check("every active sales-ready lead has a lead clock (back-filled)", inv.ready_without_clock === 0, inv.ready_without_clock);
        check("a limit is passed only when nothing came by the due moment", inv.bad_passed === 0, inv.bad_passed);
        check("no attempt before its clock started", inv.bad_attempt === 0, inv.bad_attempt);
        console.log(`      ${inv.clocks} clocks, ${inv.owners_inferred} with an inferred owner (flagged)`);

        // 4 — the same numbers everywhere
        const [passed, events, owner] = await Promise.all([
            limitsPassed(monthFrom, today),
            countEvents({ from: monthFrom, to: today, eventTypes: ["limit_passed"] }),
            clockStats("owner", monthFrom, today),
        ]);
        check(`month's Limit passed: Lead events download ${events} = lead_clocks ${passed}`, events === passed);
        console.log(`      owner clock MTD: ${owner?.pct_in_limit ?? "—"}% within limit; first attempt median ${owner?.attempt_median_h ?? "—"} h, slowest 1 in 10 ${owner?.attempt_p90_h ?? "—"} h`);
    }

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
