// AI dialer review — apply the new post-call logic to campaigns that already ran:
// re-read each conversation with the current prompt + band rule (callback /
// manager requests → Warm), record its outcome category, open callback records
// and hand sales callbacks to the CRM (Sales-ready → Ready to assign, follow-up
// date, bell). The same code a live call runs (aiCallbacks.reprocessCall /
// postCallOutcome.applyPostCall), minus a new history entry and a retry booking.
//
//   node --import tsx --env-file=<env> scripts/reprocess-campaign-outcomes.ts                 # dry run, campaigns started in the last 7 days
//   … --days=3            window for "latest" campaigns
//   … --campaign=<id>     one campaign (repeatable) instead of the window
//   … --apply             do it (costs one OpenAI extraction per connected call)
//
// Only each campaign row's LATEST attempt is processed. Calls where the dealer
// never spoke are categorised without an LLM call. Needs E-356 on that DB.
// Idempotent: a re-run rewrites the same outcome rows and refreshes the same
// open callback (one per lead); bells go out only for newly opened callbacks.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { reprocessCall } from "@/lib/ai-dialer/aiCallbacks";
import { applyPostCall, preparePostCall } from "@/lib/ai-dialer/postCallOutcome";
import { CALL_CATEGORY_LABELS, isCallCategory } from "@/lib/ai-dialer/callCategory";
import { ATTEMPTED_STATUSES, type CallEndStatus } from "@/lib/ai-dialer/campaignLeadStatus";
import { hasCallOutcomeTables } from "@/lib/ai/storage/callOutcomeStore";

const apply = process.argv.includes("--apply");
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 7);
const campaignIds = process.argv.filter((a) => a.startsWith("--campaign=")).map((a) => a.split("=")[1]);

type Row = {
    campaign_id: string;
    campaign_name: string;
    campaign_lead_id: string;
    lead_id: string;
    status: string;
    call_outcome: string | null;
    call_id: string;
    provider: string | null;
    has_transcript: boolean;
    lead_exists: boolean;
    band: string | null;
    intent_score: number | null;
    at: string | null;
};

async function main() {
    console.log(`database: ${(process.env.DATABASE_URL ?? "").match(/@([^.:/]+)/)?.[1] ?? "?"} · ${apply ? "APPLY" : "dry run"}`);
    if (!(await hasCallOutcomeTables())) {
        console.error("E-356 is not applied on this database — apply it first (scripts/_apply-e356.mjs).");
        process.exit(1);
    }

    const rows = (await db.execute(sql`
        SELECT dcl.campaign_id, c.name AS campaign_name, dcl.id AS campaign_lead_id, dcl.lead_id,
               dcl.status, dcl.call_outcome, dcl.bolna_call_id AS call_id,
               COALESCE(acl.provider, c.provider) AS provider,
               (acl.transcript IS NOT NULL) AS has_transcript,
               EXISTS (SELECT 1 FROM dealer_leads dl WHERE dl.id = dcl.lead_id) AS lead_exists,
               acl.band, acl.intent_score,
               COALESCE(acl.ended_at, dcl.completed_at)::text AS at
          FROM dialer_campaign_leads dcl
          JOIN dialer_campaigns c ON c.id = dcl.campaign_id
          LEFT JOIN ai_call_logs acl ON acl.call_id = dcl.bolna_call_id
         WHERE dcl.bolna_call_id IS NOT NULL
           AND dcl.status IN ${[...ATTEMPTED_STATUSES]}
           AND ${campaignIds.length > 0 ? sql`dcl.campaign_id IN ${campaignIds}` : sql`c.started_at > now() - make_interval(days => ${days})`}
         ORDER BY c.started_at DESC, dcl.queue_position
    `)) as unknown as Row[];

    const campaigns = [...new Map(rows.map((r) => [r.campaign_id, r.campaign_name])).entries()];
    console.log(`${campaigns.length} campaign(s), ${rows.length} finished attempt(s):`);
    for (const [id, name] of campaigns) {
        const mine = rows.filter((r) => r.campaign_id === id);
        console.log(`  ${name} (${id}) — ${mine.length} calls, ${mine.filter((r) => r.status === "completed").length} connected`);
    }
    if (!apply) {
        const toAnalyse = rows.filter((r) => r.status === "completed" && r.has_transcript && r.lead_exists).length;
        console.log(`\ndry run — would re-analyse ${toAnalyse} connected call(s) and categorise ${rows.length - toAnalyse} other(s). Pass --apply.`);
        return;
    }

    const tally = new Map<string, number>();
    let failed = 0;
    for (const r of rows) {
        const provider = (r.provider === "elevenlabs" ? "elevenlabs" : "bolna") as "bolna" | "elevenlabs";
        const when = r.at ? new Date(r.at) : undefined;
        let category: string;
        if (r.status === "completed" && r.has_transcript && r.lead_exists) {
            const res = await reprocessCall({
                callId: r.call_id,
                provider,
                leadId: r.lead_id,
                campaignId: r.campaign_id,
                campaignLeadId: r.campaign_lead_id,
                campaignStatus: r.status,
                now: when,
            });
            if (res.status === "skipped") {
                if (res.reason.includes("openai_no_credits")) {
                    console.error("\nOpenAI has no credits — stopping. Add credits, then re-run (it is idempotent).");
                    process.exit(1);
                }
                failed++;
                console.warn(`  skipped ${r.call_id}: ${res.reason}`);
                continue;
            }
            category = res.category;
            if (res.callbackOwner) console.log(`  ${r.campaign_name}: ${r.lead_id} → ${category} (score ${res.score})`);
        } else {
            // The dealer never spoke (or no lead row): category only, no LLM call.
            const callEnd = { status: r.status as CallEndStatus, outcome: null };
            const plan = await preparePostCall({
                callEnd,
                callOutcome: r.call_outcome,
                analysis: null,
                transcript: null,
                leadId: r.lead_exists ? r.lead_id : null,
                now: when,
            });
            await applyPostCall({
                provider,
                callId: r.call_id,
                leadId: r.lead_exists ? r.lead_id : null,
                plan,
                callEnd,
                band: r.band,
                intentScore: r.intent_score,
                summary: null,
                transcript: null,
                campaign: { campaignId: r.campaign_id, campaignLeadId: r.campaign_lead_id, retryAt: null },
            });
            category = plan.cat.category;
        }
        tally.set(category, (tally.get(category) ?? 0) + 1);
    }

    console.log("\ncategories:");
    for (const [c, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${(isCallCategory(c) ? CALL_CATEGORY_LABELS[c] : c).padEnd(26)} ${String(n).padStart(5)}`);
    }
    const cbs = (await db.execute(sql`
        SELECT owner_type, status, COUNT(*)::int AS n FROM lead_callbacks
         WHERE campaign_id IN ${campaigns.map(([id]) => id)} GROUP BY 1, 2 ORDER BY 1, 2
    `)) as unknown as Array<{ owner_type: string; status: string; n: number }>;
    console.log("callbacks:", cbs.map((c) => `${c.owner_type}/${c.status}=${c.n}`).join(", ") || "none");
    if (failed) console.log(`${failed} call(s) could not be re-analysed (left as they were)`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
