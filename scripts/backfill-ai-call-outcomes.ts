// E-356 — categorise AI dialer calls made BEFORE the outcome category existed,
// so a campaign's "Call outcomes" panel covers its whole history.
//
//   node --import tsx --env-file=.env.local scripts/backfill-ai-call-outcomes.ts            # dry run
//   node --import tsx --env-file=.env.local scripts/backfill-ai-call-outcomes.ts --apply
//   … --campaign=<id>   only one campaign
//
// Reads each campaign row's LATEST attempt (dialer_campaign_leads.bolna_call_id)
// with its ai_call_logs row, and runs the REAL rule (callCategory.categorizeCall)
// on the stored status + signals. Dry run prints the distribution; --apply
// inserts ai_call_outcomes rows dated at the call, skipping any call that
// already has one (live rows written by the finalizers are never touched).
//
// Calls from before the band model carry no band — it is read from their stored
// score (thresholds.leadStatusFor). Old calls predate signals-2.2.0, so they
// carry no callback_topic / wants_human:
// a callback whose AI summary mentions price / rate / discount / dealership /
// order is filed as callback_sales, every other callback as callback_ai. No
// callback records (lead_callbacks) and no CRM hand-offs are created — those are
// for live calls only.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    CALL_CATEGORY_LABELS,
    CALL_CATEGORY_ORDER,
    CALL_CATEGORY_VERSION,
    categorizeCall,
    type CallCategory,
} from "@/lib/ai-dialer/callCategory";
import { ATTEMPTED_STATUSES, type CallEndStatus } from "@/lib/ai-dialer/campaignLeadStatus";
import {
    EMPTY_SIGNALS,
    leadStatusFor,
    QualificationSignalsSchema,
    statusToBand,
    type Band,
    type CallStatus,
} from "@/lib/ai/scoring";
import { hasCallOutcomeTables } from "@/lib/ai/storage/callOutcomeStore";

const apply = process.argv.includes("--apply");
const campaignArg = process.argv.find((a) => a.startsWith("--campaign="))?.split("=")[1] ?? null;
const SALES_WORDS = /\b(price|pricing|rate|discount|margin|deal(er)?ship|distributor|order|purchase|stock|kimat|keemat|daam)\b/i;

type Row = {
    campaign_id: string;
    campaign_lead_id: string;
    lead_id: string;
    status: string;
    call_outcome: string | null;
    call_id: string;
    provider: string | null;
    log_status: string | null;
    signals: unknown;
    band: string | null;
    call_status: string | null;
    info_signals_count: number | null;
    intent_score: number | null;
    summary: string | null;
    has_transcript: boolean | null;
    at: string | null;
    has_outcome: boolean;
};

async function main() {
    const tables = await hasCallOutcomeTables();
    console.log(`E-356 tables present: ${tables ? "yes" : "NO"}${apply && !tables ? " — cannot --apply" : ""}`);
    if (apply && !tables) process.exit(1);

    const rows = (await db.execute(sql`
        SELECT dcl.campaign_id, dcl.id AS campaign_lead_id, dcl.lead_id, dcl.status, dcl.call_outcome,
               dcl.bolna_call_id AS call_id, acl.provider, acl.status AS log_status, acl.signals,
               acl.band, acl.call_status, acl.info_signals_count, acl.intent_score, acl.summary,
               (acl.transcript IS NOT NULL) AS has_transcript,
               COALESCE(acl.ended_at, dcl.completed_at)::text AS at,
               ${tables ? sql`EXISTS (SELECT 1 FROM ai_call_outcomes o WHERE o.call_id = dcl.bolna_call_id)` : sql`false`} AS has_outcome
          FROM dialer_campaign_leads dcl
          LEFT JOIN ai_call_logs acl ON acl.call_id = dcl.bolna_call_id
         WHERE dcl.bolna_call_id IS NOT NULL
           AND dcl.status IN ${[...ATTEMPTED_STATUSES]}
           ${campaignArg ? sql`AND dcl.campaign_id = ${campaignArg}` : sql``}
    `)) as unknown as Row[];

    const counts = new Map<CallCategory, number>();
    let connected = 0;
    let connectedNoScore = 0;
    let already = 0;
    let written = 0;

    for (const r of rows) {
        // Only band-model signals (signals-2.0.0+, they carry `disqualifier`) are
        // facts; the old BANT shape would parse into all-default "no"s.
        const bandShape = !!r.signals && typeof r.signals === "object" && "disqualifier" in (r.signals as object);
        const parsed = bandShape ? QualificationSignalsSchema.safeParse(r.signals) : null;
        const failed = r.log_status === "needs_review";
        // Calls scored before the band model (no band column) still carry the
        // old numeric score — read the band from it, as the human override does.
        const band: Band | null =
            (r.band as Band | null) ?? (r.intent_score != null ? statusToBand(leadStatusFor(r.intent_score)) : null);
        // A legacy call states no facts — relevant_dealer is unknown, not "no", so
        // a low old score is not read as "not our market".
        const signals = parsed?.success ? parsed.data : band ? { ...EMPTY_SIGNALS, relevant_dealer: "yes" as const } : null;
        if (signals && signals.callback_agreed === "yes" && signals.callback_topic === "none" && SALES_WORDS.test(r.summary ?? "")) {
            signals.callback_topic = "pricing";
        }
        const cat = categorizeCall({
            campaignStatus: r.status as CallEndStatus,
            callOutcome: r.call_outcome,
            analysis:
                signals && !failed
                    ? {
                          band,
                          call_status: (r.call_status as CallStatus | null) ?? "complete",
                          info_signals_count: Number(r.info_signals_count ?? 0),
                          signals,
                      }
                    : null,
            analysisFailed: failed,
        });
        counts.set(cat.category, (counts.get(cat.category) ?? 0) + 1);
        if (cat.connected) {
            connected++;
            if (r.intent_score == null) connectedNoScore++;
        }
        if (r.has_outcome) {
            already++;
            continue;
        }
        if (!apply) continue;
        await db.execute(sql`
            INSERT INTO ai_call_outcomes (
                call_id, provider, lead_id, campaign_id, campaign_lead_id, category, connected,
                campaign_status, band, intent_score, callback_owner, callback_topic, wants_human,
                will_retry, summary, rule_version, created_at, updated_at
            ) VALUES (
                ${r.call_id}, ${r.provider}, ${r.lead_id}, ${r.campaign_id}, ${r.campaign_lead_id}, ${cat.category},
                ${cat.connected}, ${r.status}, ${band}, ${r.intent_score}, ${cat.callbackOwner}, ${cat.callbackTopic},
                ${cat.wantsHuman}, false, ${r.summary}, ${`${CALL_CATEGORY_VERSION}+backfill`},
                COALESCE(${r.at}::timestamptz, now()), now()
            )
            ON CONFLICT (call_id) DO NOTHING
        `);
        written++;
    }

    console.log(`\n${rows.length} finished campaign attempts${campaignArg ? ` in ${campaignArg}` : ""}:`);
    for (const c of CALL_CATEGORY_ORDER) {
        const n = counts.get(c) ?? 0;
        if (n) console.log(`  ${CALL_CATEGORY_LABELS[c].padEnd(26)} ${String(n).padStart(6)}`);
    }
    console.log(`\nconnected: ${connected}  ·  connected with NO intent score: ${connectedNoScore}`);
    console.log(`already categorised: ${already}`);
    console.log(apply ? `inserted: ${written}` : "dry run — nothing written (pass --apply)");
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
