/**
 * Tracker ID 82 — Sales-ready event and "Ready to assign": the four points of
 * the 30 Sep review, checked against the database in DATABASE_URL.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id82-sales-ready.ts
 *
 * Uses the REAL builders (the CEO control tower, the Ready to assign list, the
 * Sales Daily email) and the real writer (markSalesReady). Leaves nothing
 * behind: every write happens inside a transaction that is always rolled
 * back. Exit code 1 if anything FAILs.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { buildControlTower } from "@/lib/dashboard/ceoControlTower";
import { salesDailyDigest } from "@/lib/digests/kinds/sales-daily";
import {
    AWAITING_ASSIGNMENT_OVERDUE_DAYS,
    awaitingAssignment,
    countAwaitingAssignment,
    daysAwaitingAssignment,
    listReadyToAssign,
    markSalesReady,
} from "@/lib/leads/salesReady";
import { writeTouchpoint } from "@/lib/touchpoints/write";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
class Rollback extends Error {}
let failed = 0;
const say = (outcome: "PASS" | "FAIL" | "SKIP", label: string, detail = "") => {
    if (outcome === "FAIL") failed += 1;
    console.log(`${outcome}  ${label}${detail ? ` — ${detail}` : ""}`);
};
async function rolledBack(fn: (tx: Tx) => Promise<void>) {
    try {
        await db.transaction(async (tx) => {
            await fn(tx);
            throw new Rollback();
        });
    } catch (e) {
        if (!(e instanceof Rollback)) throw e;
    }
}

async function main() {
    console.log("database:", new URL(process.env.DATABASE_URL!).host.split(".")[0], "\n");

    // ── 1. card, page and email count the same leads ──────────────────────
    const counts = await countAwaitingAssignment();
    const [all, overdue] = await Promise.all([
        listReadyToAssign({ limit: 100_000 }),
        listReadyToAssign({ minDays: AWAITING_ASSIGNMENT_OVERDUE_DAYS, limit: 100_000 }),
    ]);
    console.log(`awaiting assignment: ${counts.total} in all, ${counts.overdue} waiting ${AWAITING_ASSIGNMENT_OVERDUE_DAYS}+ days, longest ${counts.oldestDays ?? "—"} days`);
    say(all.length === counts.total ? "PASS" : "FAIL", "the page's \"All awaiting\" list is the count it shows", `${all.length} listed, ${counts.total} counted`);
    say(
        overdue.length === counts.overdue ? "PASS" : "FAIL",
        `the page's "${AWAITING_ASSIGNMENT_OVERDUE_DAYS}+ days" list is the count it shows`,
        `${overdue.length} listed, ${counts.overdue} counted`,
    );

    // Any window: the card is "as of now" and does not depend on it.
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const tower = await buildControlTower({ startStr: day(new Date(Date.now() - 30 * 86400_000)), endStr: day(new Date()) });
    const card = tower.exceptions;
    if (!card) {
        say("FAIL", "the CEO card builds");
    } else {
        say(
            card.unassigned_over_7d === overdue.length ? "PASS" : "FAIL",
            "the CEO card's number is the list it opens (?min_days=7)",
            `card ${card.unassigned_over_7d}, list ${overdue.length}`,
        );
        say(
            card.awaiting_assignment_total === counts.total ? "PASS" : "FAIL",
            "the card's \"awaiting in all\" is the page's total",
            `card ${card.awaiting_assignment_total}, page ${counts.total}`,
        );
    }

    const dead = (await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM dealer_leads dl
         WHERE dl.current_owner_id IS NULL AND dl.is_active IS NOT FALSE
           AND COALESCE(dl.lead_status, '') NOT IN ('Won', 'Converted', 'Lost')
           AND (to_jsonb(dl) ->> 'sales_ready_at') IS NOT NULL
           AND (to_jsonb(dl) ->> 'contactability') IS NOT NULL`)) as unknown as Array<{ n: number }>;
    const listed = new Set(all.map((r) => r.id));
    const deadListed = (await db.execute(sql`
        SELECT dl.id FROM dealer_leads dl
         WHERE (to_jsonb(dl) ->> 'contactability') IS NOT NULL AND (to_jsonb(dl) ->> 'sales_ready_at') IS NOT NULL`)) as unknown as Array<{ id: string }>;
    say(
        deadListed.every((r) => !listed.has(r.id)) ? "PASS" : "FAIL",
        "no dead / non-responsive number is awaiting assignment, on the card or the list",
        `${Number(dead[0]?.n ?? 0)} such sales-ready unowned leads exist and are left out`,
    );

    const yesterday = String(((await db.execute(sql`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 1)::text AS d`)) as unknown as Array<{ d: string }>)[0].d);
    const mail = await salesDailyDigest.collect(yesterday);
    const tables = (mail.figures as { tables?: Array<{ key: string; footer?: { items: Array<{ label: string; value: string }> } }> }).tables ?? [];
    const rightNow = tables.find((t) => t.key === "block_a")?.footer?.items.find((i) => i.label === "Sales-ready, no owner")?.value ?? "";
    say(
        mail.ok && Number.parseInt(rightNow, 10) === counts.total ? "PASS" : "FAIL",
        "the daily email's \"Sales-ready, no owner\" is the same number",
        `email "${rightNow}", page ${counts.total}`,
    );

    // ── every path that gives a lead an owner writes the event ────────────
    // So an owned lead with no event means a writer was missed — or the
    // backfill (scripts/backfill-sales-ready.ts) has not run since the code
    // that writes it was deployed.
    const ownedNoEvent = (await db.execute(sql`
        SELECT COUNT(*)::int AS n, MAX(dl.created_at)::text AS newest FROM dealer_leads dl
         WHERE dl.current_owner_id IS NOT NULL AND dl.is_active IS NOT FALSE
           AND (to_jsonb(dl) ->> 'sales_ready_at') IS NULL`)) as unknown as Array<{ n: number; newest: string | null }>;
    const missing = Number(ownedNoEvent[0]?.n ?? 0);
    say(
        missing === 0 ? "PASS" : "FAIL",
        "every lead that has an owner has a Sales-ready event",
        missing === 0 ? "" : `${missing} do not (newest created ${ownedNoEvent[0]?.newest}) — run scripts/backfill-sales-ready.ts`,
    );

    // ── 2. the event itself: first one wins, dated, with a timeline entry ──
    const [lead] = (await db.execute(sql`
        SELECT id FROM dealer_leads dl
         WHERE dl.is_active IS NOT FALSE AND (to_jsonb(dl) ->> 'sales_ready_at') IS NULL AND dl.current_owner_id IS NULL
         ORDER BY dl.created_at DESC LIMIT 1`)) as unknown as Array<{ id: string }>;
    if (!lead) {
        say("SKIP", "the Sales-ready event — no unowned lead without one");
    } else {
        await rolledBack(async (tx) => {
            const first = await markSalesReady(tx, { leadId: lead.id, reason: "rep_created", actorId: null });
            const second = await markSalesReady(tx, { leadId: lead.id, reason: "admin_marked", actorId: null });
            const [row] = (await tx.execute(sql`
                SELECT sales_ready_reason AS reason, sales_ready_at IS NOT NULL AS dated,
                       (SELECT COUNT(*)::int FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type = 'sales_ready') AS events
                  FROM dealer_leads dl WHERE dl.id = ${lead.id}`)) as unknown as Array<{ reason: string; dated: boolean; events: number }>;
            say(
                first && !second && row.dated && row.reason === "rep_created" && Number(row.events) === 1 ? "PASS" : "FAIL",
                "a lead created by hand gets a dated Sales-ready event; a later event does not move it",
                `reason ${row.reason}, ${row.events} timeline entry, second event ${second ? "moved it" : "ignored"}`,
            );
            const [inQueue] = (await tx.execute(sql`
                SELECT COUNT(*)::int AS n FROM dealer_leads dl
                 WHERE dl.id = ${lead.id} AND dl.current_owner_id IS NULL AND (to_jsonb(dl) ->> 'sales_ready_at') IS NOT NULL`)) as unknown as Array<{ n: number }>;
            say(Number(inQueue.n) === 1 ? "PASS" : "FAIL", "and with no owner it is in Ready to assign from that moment");
        });
    }

    // ── a lead back in the pool waits from when it came back ──────────────
    const [lost] = (await db.execute(sql`
        SELECT id, lost_reason FROM dealer_leads dl
         WHERE dl.is_active IS NOT FALSE AND dl.lead_status = 'Lost' AND (to_jsonb(dl) ->> 'contactability') IS NULL
         ORDER BY dl.updated_at DESC LIMIT 1`)) as unknown as Array<{ id: string; lost_reason: string | null }>;
    if (!lost) {
        say("SKIP", "reactivated lead — no Lost lead to try it on");
    } else {
        await rolledBack(async (tx) => {
            // As if it became sales-ready 100 days ago, then was lost …
            await tx.execute(sql`
                UPDATE dealer_leads SET sales_ready_at = now() - INTERVAL '100 days', sales_ready_reason = 'claimed_by_rep'
                 WHERE id = ${lost.id}`);
            // … and is reactivated today with nobody to return to (reactivation.ts).
            await tx.execute(sql`UPDATE dealer_leads SET current_owner_id = NULL WHERE id = ${lost.id}`);
            await writeTouchpoint(
                {
                    dealerLeadId: lost.id,
                    touchpointType: "reactivated_via_admin",
                    performedBy: null,
                    remarks: "verify script",
                    statusChange: { from: "Lost", to: "New_Unassigned", fromLostReason: lost.lost_reason as never, event: "reactivation" },
                },
                { tx },
            );
            const again = await markSalesReady(tx, { leadId: lost.id, reason: "reactivated", actorId: null });
            const [row] = (await tx.execute(sql`
                SELECT ${daysAwaitingAssignment()} AS waiting,
                       FLOOR(EXTRACT(EPOCH FROM (now() - dl.sales_ready_at)) / 86400)::int AS since_event,
                       dl.sales_ready_reason AS reason,
                       (SELECT COUNT(*)::int FROM dealer_leads x WHERE x.id = dl.id AND ${awaitingAssignment(sql`x`)}) AS in_queue
                  FROM dealer_leads dl WHERE dl.id = ${lost.id}`)) as unknown as Array<{ waiting: number; since_event: number; reason: string; in_queue: number }>;
            say(
                Number(row.in_queue) === 1 && Number(row.waiting) === 0 && Number(row.since_event) >= 99 ? "PASS" : "FAIL",
                "a Lost lead reactivated into the pool is in Ready to assign, waiting from today — not from its first Sales-ready date",
                `waiting ${row.waiting} days; its Sales-ready event is ${row.since_event} days old`,
            );
            say(
                !again && row.reason === "claimed_by_rep" ? "PASS" : "FAIL",
                "and the first Sales-ready event keeps its date and reason",
                `reason ${row.reason}`,
            );
        });
    }

    console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
}

main()
    .catch((e) => {
        console.error(e);
        failed += 1;
    })
    .finally(() => process.exit(failed ? 1 : 0));
