// E-356 — read-only health check of the AI dialer's outcome categories and
// callbacks against a real database. Writes nothing; safe on prod.
//
//   node --import tsx --env-file=.env.local scripts/verify-ai-call-outcomes.ts [--days=7]
//
// Checks, over the last N days:
//   1. every finished AI call has an ai_call_outcomes row (coverage);
//   2. the category distribution;
//   3. connected calls (the dealer spoke) with NO intent score — review point 7
//      says this should be 0 apart from calls still waiting for a re-score;
//   4. callbacks: open per owner, overdue, and that every open SALES callback
//      reached the CRM (Sales-ready stamped, follow-up date set);
//   5. calls cut off mid-conversation and whether their retry was booked.
// Uses the shared predicates (AI_CONNECTED_CALL_PREDICATE, the category vocabulary)
// rather than restating them.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { AI_CONNECTED_CALL_PREDICATE } from "@/lib/ai-dialer/exclusionFilter";
import { CALL_CATEGORY_LABELS, isCallCategory } from "@/lib/ai-dialer/callCategory";
import { aiCallbacksEnabled } from "@/lib/ai-dialer/aiCallbacks";
import { hasCallOutcomeTables } from "@/lib/ai/storage/callOutcomeStore";

const days = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 7);
const since = sql`now() - make_interval(days => ${days})`;
let warnings = 0;

function line(ok: boolean, label: string, detail: string | number) {
    console.log(`${ok ? "PASS" : "WARN"}  ${label}: ${detail}`);
    if (!ok) warnings++;
}

async function one<T>(q: ReturnType<typeof sql>): Promise<T> {
    return ((await db.execute(q)) as unknown as T[])[0];
}

async function main() {
    console.log(`database: ${(process.env.DATABASE_URL ?? "").match(/@([^.:/]+)/)?.[1] ?? "?"} · last ${days} day(s)`);
    console.log(`AI_CALLBACKS_ENABLED: ${aiCallbacksEnabled() ? "on" : "off"} (in this shell)\n`);

    if (!(await hasCallOutcomeTables())) {
        console.log("E-356 is NOT applied here — ai_call_outcomes / lead_callbacks missing. Nothing to check.");
        return;
    }

    // 1. Coverage.
    const cov = await one<{ calls: number; missing: number }>(sql`
        SELECT COUNT(*)::int AS calls,
               COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ai_call_outcomes o WHERE o.call_id = acl.call_id))::int AS missing
          FROM ai_call_logs acl
         WHERE acl.created_at >= ${since} AND acl.lead_id IS NOT NULL
    `);
    line(cov.missing === 0, "calls without an outcome row", `${cov.missing} of ${cov.calls}`);

    // 2. Distribution.
    const dist = (await db.execute(sql`
        SELECT category, COUNT(*)::int AS n FROM ai_call_outcomes
         WHERE created_at >= ${since} GROUP BY category ORDER BY n DESC
    `)) as unknown as Array<{ category: string; n: number }>;
    console.log("\ncategory distribution:");
    for (const d of dist) {
        console.log(`  ${(isCallCategory(d.category) ? CALL_CATEGORY_LABELS[d.category] : d.category).padEnd(26)} ${String(d.n).padStart(6)}`);
    }
    console.log("");

    // 3. Connected with no score.
    const ns = await one<{ total: number; review: number; other: number }>(sql`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE acl.status = 'needs_review')::int AS review,
               COUNT(*) FILTER (WHERE acl.status <> 'needs_review')::int AS other
          FROM ai_call_logs acl
         WHERE acl.created_at >= ${since} AND acl.intent_score IS NULL
           AND ${sql.raw(AI_CONNECTED_CALL_PREDICATE)}
    `);
    line(ns.other === 0, "connected calls with no score (not awaiting re-score)", ns.other);
    line(ns.review === 0, "connected calls awaiting re-score (needs_review)", ns.review);

    // 4. Callbacks.
    const cb = await one<{ ai_open: number; sales_open: number; overdue_sales: number; overdue_ai: number }>(sql`
        SELECT COUNT(*) FILTER (WHERE owner_type = 'ai' AND status IN ('open','dialing'))::int AS ai_open,
               COUNT(*) FILTER (WHERE owner_type = 'sales' AND status IN ('open','dialing'))::int AS sales_open,
               COUNT(*) FILTER (WHERE owner_type = 'sales' AND status = 'open' AND due_at < now() - interval '48 hours')::int AS overdue_sales,
               COUNT(*) FILTER (WHERE owner_type = 'ai' AND status = 'open' AND due_at < now() - interval '24 hours')::int AS overdue_ai
          FROM lead_callbacks
    `);
    console.log(`open callbacks: sales ${cb.sales_open} · AI ${cb.ai_open}`);
    line(cb.overdue_sales === 0, "sales callbacks open > 48h past due", cb.overdue_sales);
    line(
        cb.overdue_ai === 0 || !aiCallbacksEnabled(),
        "AI callbacks open > 24h past due",
        `${cb.overdue_ai}${aiCallbacksEnabled() ? "" : " (re-dial is off — expected to accumulate)"}`,
    );
    const handoff = await one<{ not_ready: number; no_follow_up: number }>(sql`
        SELECT COUNT(*) FILTER (WHERE (to_jsonb(dl) ->> 'sales_ready_at') IS NULL)::int AS not_ready,
               COUNT(*) FILTER (WHERE dl.next_follow_up_at IS NULL)::int AS no_follow_up
          FROM lead_callbacks cb JOIN dealer_leads dl ON dl.id = cb.lead_id
         WHERE cb.owner_type = 'sales' AND cb.status IN ('open','dialing')
    `);
    line(handoff.not_ready === 0, "open sales callbacks whose lead is not Sales-ready", handoff.not_ready);
    line(handoff.no_follow_up === 0, "open sales callbacks with no follow-up date", handoff.no_follow_up);

    // 5. Disconnected → retry.
    const dc = await one<{ n: number; retry: number; no_budget: number }>(sql`
        SELECT COUNT(*)::int AS n,
               COUNT(*) FILTER (WHERE o.will_retry)::int AS retry,
               COUNT(*) FILTER (WHERE NOT o.will_retry AND c.max_retries IS NULL)::int AS no_budget
          FROM ai_call_outcomes o
          LEFT JOIN dialer_campaigns c ON c.id = o.campaign_id
         WHERE o.created_at >= ${since} AND o.category = 'disconnected' AND o.campaign_id IS NOT NULL
    `);
    line(
        dc.n - dc.retry - dc.no_budget === 0,
        "disconnected campaign calls without a booked retry (campaign has a retry budget)",
        `${dc.n - dc.retry - dc.no_budget} of ${dc.n} (${dc.retry} booked, ${dc.no_budget} on campaigns with auto-retry off)`,
    );

    console.log(`\n${warnings === 0 ? "✓ all checks pass" : `${warnings} warning(s)`}`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
