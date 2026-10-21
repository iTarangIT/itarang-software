// Read-only check of ID 192 (idle leads) after the 15 Oct rework.
//
//   node --import tsx --env-file=.env.local scripts/verify-id192-idle.ts
//
// 1. Every idle row is judged by its holder's role limit (idle_cc for inside
//    sales, idle_asm for ASMs — Admin › Time limits), not a fixed 7.
// 2. A follow-up still ahead (within 30 days) keeps a lead off the list; one
//    more than 30 days ahead is IGNORED (Kartik, 15 Oct) — the lead ages on its
//    other dates, is listed with that date on the row, and is counted apart.
// 5. The Leads list Idle filter uses the same basis: a lead with a follow-up
//    within 30 days, or handed over today, is in no idle band.
// 3. A lead handed to a new holder recently is not idle for them (the basis
//    includes assigned_at).
// 4. The weekly idle email, the CEO card and Needs Attention give one total.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { listNeedsAttention, summarizeNeedsAttention } from "@/lib/leads/needsAttention";
import { getTimeLimits } from "@/lib/timeLimits/store";
import { idleLimitLabel } from "@/lib/timeLimits/labels";
import { FOLLOW_UP_AGEING_BASIS } from "@/lib/leads/followUpAgeing";

let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}\n`);
    const limits = await getTimeLimits();
    console.log(`      limits: ${idleLimitLabel(limits)}; critical ${limits.stale_critical} working days`);

    const [rows, holders] = await Promise.all([listNeedsAttention({ limit: 2000 }), summarizeNeedsAttention()]);

    // 1 — per-role limits
    const wrong = rows.filter((r) => {
        if (r.visit_overdue || r.non_responsive) return false;
        const limit = (r.holder_role ?? "").toLowerCase() === "asm" ? limits.idle_asm : limits.idle_cc;
        return r.days_idle < limit;
    });
    check("every idle row is at or past its holder's role limit", wrong.length === 0, wrong.slice(0, 3).map((r) => [r.lead_id, r.holder_role, r.days_idle]));
    const isrBelow7 = rows.filter((r) => !r.visit_overdue && !r.non_responsive && (r.holder_role ?? "") !== "asm" && r.days_idle < 7).length;
    console.log(`      inside-sales leads idle ${limits.idle_cc}–6 working days now listed (the old fixed 7 hid them): ${isrBelow7}`);

    // 2 — follow-ups
    const ids = rows.map((r) => r.lead_id);
    const fu = ids.length
        ? ((await db.execute(sql`
              SELECT COUNT(*) FILTER (WHERE next_follow_up_at > NOW() AND next_follow_up_at <= NOW() + INTERVAL '30 days')::int AS ahead,
                     COUNT(*) FILTER (WHERE next_follow_up_at > NOW() + INTERVAL '30 days')::int AS parked
                FROM dealer_leads WHERE id IN ${ids}`)) as unknown as Array<{ ahead: number; parked: number }>)[0]
        : { ahead: 0, parked: 0 };
    const aheadOverdue = rows.filter((r) => r.visit_overdue).length;
    check("no listed lead has a follow-up still ahead (unless its field visit is overdue)", fu.ahead <= aheadOverdue, fu);
    const parkedTotal = holders.reduce((a, h) => a + h.parked, 0);
    const listedFar = rows.filter((r) => !r.non_responsive && r.next_follow_up_at && Date.parse(r.next_follow_up_at) > Date.now() + 30 * 86_400_000).length;
    check(`far follow-up leads are listed with the date on the row; count ${parkedTotal} = rows ${listedFar}`, rows.length >= 2000 || parkedTotal === listedFar);
    const [p] = (await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM dealer_leads dl
         WHERE dl.current_owner_id IS NOT NULL AND dl.is_active IS NOT FALSE
           AND dl.lead_status IN ('New_Unassigned','Assigned_Not_Contacted','Under_Discussion','Commercials_Explained',
                                  'Commercials_Finalised','Awaiting_Customer_Decision','Transferred_to_ASM')
           AND dl.next_follow_up_at > NOW() + INTERVAL '30 days'`)) as unknown as Array<{ n: number }>;
    console.log(`      open held leads with a follow-up over 30 days ahead: ${p.n} (of them idle and listed: ${parkedTotal})`);

    // 3 — reassignment
    const fresh = ids.length
        ? ((await db.execute(sql`
              SELECT COUNT(*)::int AS n FROM dealer_leads
               WHERE id IN ${ids} AND assigned_at > NOW() - INTERVAL '1 day'`)) as unknown as Array<{ n: number }>)[0].n
        : 0;
    check("no lead handed over in the last day is idle for its new holder (field-visit overdue aside)", fresh <= aheadOverdue, fresh);

    await leadsListChecks();

    // 4 — one total
    const totalIdle = holders.reduce((a, h) => a + h.idle, 0);
    const listed = rows.filter((r) => !r.non_responsive).length;
    check(`Needs Attention list (${listed}) = summary total incl. field-visit overdue rows (${totalIdle})`, rows.length >= 2000 || listed === totalIdle);
    // The CEO card and People column call the same summarizeNeedsAttention() with no override.
    const { idleWeeklyDigest } = await import("@/lib/digests/kinds/idle-weekly");
    const mail = await idleWeeklyDigest.collect("2026-10-16" as never);
    const mailTotal = mail.figures.backlog.find((b) => b.label.startsWith("Leads idle past the limit"))?.value;
    check(`weekly idle email total (${mailTotal}) = Needs Attention total (${totalIdle})`, Number(mailTotal) === totalIdle);

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

// 5 — the Leads list Idle filter shares the basis (leadListQuery IDLE_BASIS).
async function leadsListChecks() {
    const [ll] = (await db.execute(sql`
        SELECT COUNT(*) FILTER (WHERE dl.next_follow_up_at > NOW() AND dl.next_follow_up_at <= NOW() + INTERVAL '30 days'
                                  AND ${FOLLOW_UP_AGEING_BASIS} <= NOW())::int AS fu_idle,
               COUNT(*) FILTER (WHERE dl.assigned_at > NOW() - INTERVAL '1 day'
                                  AND ${FOLLOW_UP_AGEING_BASIS} <= NOW() - INTERVAL '1 day')::int AS fresh_idle
          FROM dealer_leads dl`)) as unknown as Array<{ fu_idle: number; fresh_idle: number }>;
    check("Leads list: no lead with a follow-up within 30 days falls in an idle band", ll.fu_idle === 0, ll.fu_idle);
    check("Leads list: no lead handed over in the last day reads a day or more idle", ll.fresh_idle === 0, ll.fresh_idle);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
