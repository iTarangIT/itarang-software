// Read-only check of the follow-up ageing rule (src/lib/leads/followUpAgeing.ts)
// on the database DATABASE_URL points at:
//   1. The needs-attention summary (the Idle tile, the page, the weekly mail)
//      now never counts a lead whose follow-up is still ahead.
//   2. Before / after: how many leads the old clock
//      COALESCE(last_worked_at, assigned_at, created_at) flagged that the new
//      one does not (and the reverse), split by why.
//
//   node --import tsx --env-file=.env.local scripts/verify-follow-up-ageing.ts
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { workingDaysSinceSql } from "@/lib/calendar/holidays";
import { WORKABLE_STATUSES } from "@/lib/lifecycle/transitions";
import { FOLLOW_UP_AGEING_BASIS, FOLLOW_UP_HORIZON_DAYS } from "@/lib/leads/followUpAgeing";
import { listNeedsAttention, summarizeNeedsAttention } from "@/lib/leads/needsAttention";
import { getTimeLimits } from "@/lib/timeLimits/store";

let fails = 0;
const ok = (label: string, pass: boolean, detail = "") => {
    if (!pass) fails++;
    console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
    console.log(`DB: ${new URL(process.env.DATABASE_URL!).hostname}`);
    const limits = await getTimeLimits();
    const OPEN = sql.raw(WORKABLE_STATUSES.map((s) => `'${s}'`).join(", "));
    const OLD = sql`COALESCE(dl.last_worked_at, dl.assigned_at, dl.created_at)`;
    const threshold = sql`CASE WHEN lower(u.role) = 'asm' THEN ${limits.idle_asm}::int ELSE ${limits.idle_cc}::int END`;
    const pending = sql`(dl.next_follow_up_at > NOW() AND dl.next_follow_up_at <= NOW() + make_interval(days => ${FOLLOW_UP_HORIZON_DAYS}))`;

    // 1. Nothing with a pending follow-up is listed as idle.
    const listed = await listNeedsAttention({ limit: 2000 });
    const ids = listed.filter((r) => !r.non_responsive && !r.visit_overdue).map((r) => r.lead_id);
    const leak = ids.length
        ? ((await db.execute(sql`SELECT COUNT(*)::int AS n FROM dealer_leads dl
              WHERE dl.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) AND ${pending}`)) as unknown as Array<{ n: number }>)[0].n
        : 0;
    ok("no idle row has a follow-up still ahead", leak === 0, `${leak} of ${ids.length} listed`);

    // 2. Old vs new over every owned open lead (non-responsive left out, as the totals do).
    const rows = (await db.execute(sql`
        SELECT * FROM (
            SELECT (${workingDaysSinceSql(OLD)} >= ${threshold}) AS old_idle,
                   (${workingDaysSinceSql(FOLLOW_UP_AGEING_BASIS)} >= ${threshold}) AS new_idle,
                   ${pending} AS fu_pending,
                   (dl.next_follow_up_at <= NOW()) AS fu_passed,
                   (dl.assigned_at > dl.last_worked_at) AS assigned_after_work
              FROM dealer_leads dl
              LEFT JOIN users u ON u.id::text = dl.current_owner_id
             WHERE dl.current_owner_id IS NOT NULL
               AND dl.is_active IS NOT FALSE
               AND dl.lead_status IN (${OPEN})
               AND (to_jsonb(dl) ->> 'contactability') IS NULL
        ) x`)) as unknown as Array<Record<string, boolean | null>>;
    const count = (f: (r: Record<string, boolean | null>) => boolean) => rows.filter(f).length;
    const oldN = count((r) => !!r.old_idle);
    const newN = count((r) => !!r.new_idle);
    console.log(`\n  Owned open leads: ${rows.length}`);
    console.log(`  Idle, old clock: ${oldN}`);
    console.log(`  Idle, new clock: ${newN}  (${newN - oldN >= 0 ? "+" : ""}${newN - oldN})`);
    console.log(`  No longer idle — follow-up still ahead:          ${count((r) => !!r.old_idle && !r.new_idle && !!r.fu_pending)}`);
    console.log(`  No longer idle — reassigned after the last work: ${count((r) => !!r.old_idle && !r.new_idle && !r.fu_pending && !!r.assigned_after_work)}`);
    console.log(`  No longer idle — passed follow-up is recent:     ${count((r) => !!r.old_idle && !r.new_idle && !r.fu_pending && !r.assigned_after_work && !!r.fu_passed)}`);
    console.log(`  Newly idle (should be 0 — the new basis is never earlier): ${count((r) => !r.old_idle && !!r.new_idle)}`);
    ok("the new clock never makes a lead idle that the old one did not", count((r) => !r.old_idle && !!r.new_idle) === 0);

    const summary = await summarizeNeedsAttention();
    const tile = summary.reduce((a, h) => a + h.idle, 0);
    console.log(`\n  Idle tile total (summarizeNeedsAttention): ${tile}`);

    console.log(fails ? `\n${fails} FAILED` : "\nall passed");
    process.exit(fails ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
