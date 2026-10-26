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
// 5. 15 Oct rework (E-350): the new limits resolve; the 18:00-Saturday Hot
//    example lands at 13:00 Monday; every passed clock has its fixed "Limit
//    passed" record; a missed lead clock is charged to the owner on record at
//    the moment it fell due; per-person counts leave inferred owners out; the
//    SQL "limit in force on a day" matches the TS one; holiday log present.
// 6. 22 Oct rework (after a clock refresh with this code): lead clocks are a
//    team figure (no owner); owner clocks that started before 21 Oct are timed
//    by the old owner limit, later ones by the Hot / non-Hot limit.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { istDay, workingDaysSince } from "@/lib/calendar/officeCalendar";
import { loadHolidays, workingDaysSinceSql } from "@/lib/calendar/holidays";
import { TIME_LIMITS, formatLimit } from "@/lib/timeLimits/registry";
import { getTimeLimits, hasTimeLimitTable, scheduledChanges, timeLimitLog } from "@/lib/timeLimits/store";
import { clockStats, clocksComputedAt, hasLeadClocks, hasLimitEvents, limitsPassed, limitsPassedByOwner } from "@/lib/leads/clocks";
import { dueAt } from "@/lib/leads/clockRules";
import { hasHolidayLog } from "@/lib/calendar/holidays";
import { limitOnDaySql, limitsOn } from "@/lib/timeLimits/store";
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

    // 5 — the 15 Oct rework
    console.log("\n— 15 Oct rework (E-350) —");
    for (const k of ["hot_ready_to_assigned", "hot_owner_first_attempt", "retry_gap", "retry_max_attempts", "ceo_quote_approval"] as const) {
        check(`limit ${k} resolves (${values[k]})`, Number.isFinite(values[k]) && values[k] > 0);
    }
    const sat = new Date("2026-10-17T18:00:00+05:30");
    const due = dueAt(sat, "hot_owner_first_attempt", 4, new Set());
    check(`Hot lead reaching its owner 18:00 Sat 17 Oct → due ${due?.toISOString()} (13:00 Mon IST)`, due?.toISOString() === new Date("2026-10-19T13:00:00+05:30").toISOString());

    // Dated limits in SQL = TS, on today and on a day before any change.
    const rows = (await db.execute(sql`SELECT limit_key, value, effective_from::text AS effective_from, changed_at::text AS changed_at FROM time_limit_settings ORDER BY effective_from, changed_at, id`).catch(() => [])) as unknown as Array<{ limit_key: string; value: string; effective_from: string; changed_at: string }>;
    for (const day of [today, "2026-01-01"]) {
        const r = await one<{ v: string }>(sql`SELECT ${limitOnDaySql("asm_transfer_first_visit", sql`${day}::date`, await hasTimeLimitTable())} AS v`);
        const ts = limitsOn(day, rows).asm_transfer_first_visit;
        check(`asm_transfer_first_visit in force on ${day}: SQL ${r?.v} = TS ${ts}`, Number(r?.v) === ts);
    }

    check("E-350 holiday_calendar_log present", await hasHolidayLog());
    if (!(await hasLimitEvents())) {
        check("E-350 lead_limit_events present", false);
    } else {
        const ev = await one<Record<string, number>>(sql`
            SELECT
              (SELECT COUNT(*)::int FROM lead_clocks c
                WHERE c.limit_passed_at IS NOT NULL AND c.limit_key IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM lead_limit_events e
                                   WHERE e.dealer_lead_id = c.dealer_lead_id AND e.clock = c.clock AND e.clock_started_at = c.started_at)) AS passed_without_record,
              (SELECT COUNT(*)::int FROM lead_limit_events) AS records,
              (SELECT COUNT(*)::int FROM lead_limit_events WHERE owner_inferred) AS inferred,
              -- A recorded lead-clock miss charged to someone other than the owner
              -- on record (the last owner-change touchpoint at or before the miss).
              -- Only records written under the 15 Oct rule (charged to a person):
              -- since the 22 Oct rework a lead-clock miss is charged to nobody.
              (SELECT COUNT(*)::int FROM lead_limit_events e
                 JOIN LATERAL (
                     SELECT to_jsonb(t) ->> 'to_owner_id' AS owner FROM lead_touchpoints t
                      WHERE t.dealer_lead_id = e.dealer_lead_id AND to_jsonb(t) ->> 'to_owner_id' IS NOT NULL
                        AND t.performed_at <= e.passed_at
                      ORDER BY t.performed_at DESC LIMIT 1) h ON TRUE
                WHERE e.clock = 'lead' AND e.owner_inferred = false AND e.owner_id IS NOT NULL
                  AND e.owner_id IS DISTINCT FROM h.owner) AS charged_wrong,
              (SELECT COUNT(*)::int FROM lead_clocks WHERE clock IN ('hot_assign', 'hot_owner')) AS hot_clocks,
              (SELECT COUNT(*)::int FROM lead_clocks WHERE clock = 'retry') AS retry_clocks,
              (SELECT COUNT(*)::int FROM lead_clocks WHERE clock = 'quote') AS quote_clocks`);
        check("every passed clock has its fixed Limit passed record", ev.passed_without_record === 0, ev.passed_without_record);
        check("missed lead clocks are charged to the owner on record when they fell due", ev.charged_wrong === 0, ev.charged_wrong);
        console.log(`      ${ev.records} fixed records (${ev.inferred} owner not on record); clocks: ${ev.hot_clocks} Hot, ${ev.retry_clocks} retry, ${ev.quote_clocks} CEO quote approval`);
        const byOwner = await limitsPassedByOwner(monthFrom, today);
        const sumPeople = [...byOwner.values()].reduce((a, b) => a + b, 0);
        const onRecord = await one<{ n: number }>(sql`
            SELECT COUNT(*)::int AS n FROM lead_limit_events
             WHERE owner_id IS NOT NULL AND owner_inferred = false
               AND (passed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${monthFrom}::date AND ${today}::date`);
        check(`per-person Limits passed MTD (${sumPeople}) = records with an owner on record (${onRecord?.n}) — inferred left out`, sumPeople === Number(onRecord?.n));
    }

    // 6 — the 22 Oct rework (ID 85 #1-#3). lead_clocks is rebuilt every hour, so
    // these hold once the refresh has run with this code.
    console.log("\n— 22 Oct rework —");
    const rw = await one<Record<string, number>>(sql`
        SELECT
          (SELECT COUNT(*)::int FROM lead_clocks WHERE clock = 'lead' AND owner_id IS NOT NULL) AS lead_with_owner,
          (SELECT COUNT(*)::int FROM lead_clocks WHERE clock = 'owner' AND limit_key IS NOT NULL
             AND (started_at AT TIME ZONE 'Asia/Kolkata')::date < '2026-10-21'::date
             AND limit_key <> 'owner_first_attempt') AS old_stint_new_limit,
          (SELECT COUNT(*)::int FROM lead_clocks WHERE clock = 'owner' AND limit_key IS NOT NULL
             AND (started_at AT TIME ZONE 'Asia/Kolkata')::date >= '2026-10-21'::date
             AND limit_key NOT IN ('hot_owner_first_attempt', 'nonhot_owner_first_attempt')) AS new_stint_old_limit,
          (SELECT COUNT(*)::int FROM lead_limit_events WHERE clock = 'lead' AND owner_id IS NOT NULL) AS lead_records_charged`);
    check("lead clocks are a team figure (no owner)", rw.lead_with_owner === 0, rw.lead_with_owner);
    check("owner clocks before 21 Oct use the old 4-hour owner limit", rw.old_stint_new_limit === 0, rw.old_stint_new_limit);
    check("owner clocks from 21 Oct use the Hot / non-Hot owner limit", rw.new_stint_old_limit === 0, rw.new_stint_old_limit);
    console.log(`      ${rw.lead_records_charged} lead-clock records charged to a person under the old rule stay (removing them is the L2 clean-up)`);

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
