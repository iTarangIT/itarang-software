/**
 * E-249 — give historical AI calls the touchpoint they never got.
 *
 * Run: npm run backfill:ai-touchpoints -- [--apply] [--limit=N]
 *      (without --apply it reports and writes nothing)
 *
 * WHY THIS EXISTS AT ALL, rather than shipping forward-only. The AI dialer has
 * been idle for months, so a forward-only feature would ship with zero
 * observable rows and no way to check the mapper against a real call. The
 * backfill is also the mapper's acceptance test: the reasonCode histogram it
 * prints IS the evidence that the rules fire the way the table says they do,
 * against real transcripts rather than synthetic ones.
 *
 * It also produces the single biggest win in this feature. Most historical AI
 * calls never connected, and those are precisely the ones that today produce
 * NOTHING — no touchpoint, no disposition, no trace on the lead's timeline
 * beyond a row in ai_call_logs nobody looks at.
 *
 * ── WHAT IT DELIBERATELY DOES NOT WRITE ───────────────────────────────────
 *
 * dealer_leads.last_touchpoint_at — it feeds
 *   IDLE_BASIS = COALESCE(last_touchpoint_at, created_at)
 * which drives the /leads Idle column, the idle filter, `idleNeverTouched`, the
 * inside-sales queue's default ordering, and each rep's stale_leads count.
 * Backfilling it would make every affected lead visibly YOUNGER on deploy day
 * and clear stale cues nobody actioned. A months-old robot call is not human
 * attention, and the Idle column measures human attention. That is why the rows
 * are INSERTed directly rather than through writeTouchpoint(), which bumps it
 * unconditionally.
 *
 * dealer_leads.last_disposition* — a CURRENT-STATE column. The newest AI call is
 * months old, and 480 leads already carry a fresher NeoDove disposition. The
 * forward-only guard would refuse most of them anyway; not writing is clearer
 * than relying on a guard to no-op.
 *
 * dealer_leads.total_attempts — derived from follow_up_history.length by
 * leadStore, entirely independent of touchpoints. A backfill cannot and must not
 * move it.
 *
 * ── IDEMPOTENCY ───────────────────────────────────────────────────────────
 *
 * ON CONFLICT DO NOTHING against lead_touchpoints_external_uniq (E-113), keyed
 * on (external_system, external_event_id) = (provider, ai_call_logs.call_id).
 * Re-running inserts nothing; and a LIVE call for the same id later also no-ops,
 * so the backfill can never race the real writer into a duplicate.
 *
 * sync_method = 'reconciliation' distinguishes backfilled rows from live ones
 * forever — the enum already had the right word.
 */

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import {
    mapAiCallToDisposition,
    aiExternalTag,
    type AiDispositionReason,
} from "@/lib/leads/aiDisposition";

type CallRow = {
    call_id: string;
    lead_id: string;
    provider: string | null;
    status: string | null;
    transcript: string | null;
    summary: string | null;
    recording_url: string | null;
    call_duration: number | null;
    band: string | null;
    call_status: string | null;
    info_signals_count: number | null;
    signals: Record<string, unknown> | null;
    performed_at: string;
};

function rowsOf<T>(result: unknown): T[] {
    return (result as { rows?: T[] }).rows ?? (result as T[]);
}

function yesNo(v: unknown): boolean | null {
    if (v === "yes") return true;
    if (v === "no") return false;
    return null;
}

async function main() {
    const apply = process.argv.includes("--apply");
    const limitArg = process.argv.find((a) => a.startsWith("--limit="));
    const limit = limitArg ? Number(limitArg.split("=")[1]) : 5000;

    // JOIN dealer_leads guards against an ai_call_logs.lead_id pointing at a
    // deleted lead — lead_touchpoints has no FK, so such a row would insert
    // happily and be invisible forever.
    const rows = rowsOf<CallRow>(
        await db.execute(sql`
            SELECT a.call_id,
                   a.lead_id,
                   a.provider,
                   a.status,
                   a.transcript,
                   a.summary,
                   a.recording_url,
                   a.call_duration,
                   a.band,
                   a.call_status,
                   a.info_signals_count,
                   a.signals,
                   COALESCE(a.ended_at, a.created_at) AS performed_at
              FROM ai_call_logs a
              JOIN dealer_leads dl ON dl.id = a.lead_id
             WHERE a.call_id IS NOT NULL AND a.call_id <> ''
               AND NOT EXISTS (
                     SELECT 1 FROM lead_touchpoints t
                      WHERE t.external_system = COALESCE(a.provider, 'bolna')
                        AND t.external_event_id = a.call_id
                   )
             ORDER BY COALESCE(a.ended_at, a.created_at) ASC
             LIMIT ${limit}
        `),
    );

    console.log(
        `[backfill:ai-touchpoints] ${rows.length} AI call(s) without a touchpoint${apply ? "" : "  (DRY RUN — nothing will be written)"}`,
    );

    const histogram = new Map<AiDispositionReason, number>();
    const labels = new Map<string, number>();
    let inserted = 0;

    for (const r of rows) {
        const signals = (r.signals ?? {}) as Record<string, unknown>;
        const input = {
            transcript: r.transcript,
            providerStatus: r.status,
            // A stored summary of "analysis_failed — …" is how the needs_review
            // path records itself; there is no separate flag on the row.
            analysisFailed: /^analysis[_ ]failed/i.test((r.summary ?? "").trim()),
            band: r.band as never,
            bandCallStatus: r.call_status as never,
            infoSignalsCount: r.info_signals_count,
            disqualifier: (signals.disqualifier ?? null) as never,
            callbackAgreed: yesNo(signals.callback_agreed),
            relevantDealer: yesNo(signals.relevant_dealer),
            pitchHeard: yesNo(signals.pitch_heard),
        };

        const d = mapAiCallToDisposition(input);
        histogram.set(d.reasonCode, (histogram.get(d.reasonCode) ?? 0) + 1);
        const key = d.disposition ?? "(no honest label)";
        labels.set(key, (labels.get(key) ?? 0) + 1);

        if (!apply) continue;

        const provider = r.provider ?? "bolna";
        const remarks =
            d.connectStatus === "connected"
                ? input.analysisFailed
                    ? "[AI] Connected — transcript not analysed (extraction failed)"
                    : `[AI] ${r.band ?? "Connected"}${
                          r.info_signals_count != null
                              ? ` · ${r.info_signals_count}/5 signals`
                              : ""
                      }`
                : `[AI] No conversation (${r.status ?? "unknown"})`;

        try {
            await db.execute(sql`
                INSERT INTO lead_touchpoints (
                    dealer_lead_id, touchpoint_type, performed_by, performed_at,
                    call_status, call_duration_sec, is_engaged, remarks, attachments,
                    next_action, next_action_at,
                    external_system, external_event_id, sync_method,
                    disposition, disposition_bucket, connect_status,
                    external_stage, external_tag, recording_url
                ) VALUES (
                    ${r.lead_id}, 'ai_call', NULL, ${r.performed_at}::timestamptz,
                    ${d.callStatus}, ${r.call_duration}, false, ${remarks}, '[]'::jsonb,
                    'no_action', NULL,
                    ${provider}, ${r.call_id}, 'reconciliation',
                    ${d.disposition}, ${d.bucket}, ${d.connectStatus},
                    ${r.status}, ${aiExternalTag(input)}, ${r.recording_url}
                )
                ON CONFLICT (external_system, external_event_id) DO NOTHING
            `);
            inserted += 1;
        } catch (err) {
            console.error(`  ! ${r.call_id}:`, (err as Error).message.slice(0, 160));
        }
    }

    // THE acceptance evidence. Eyeball this against the rule table in
    // aiDisposition.ts before running with --apply on a second environment.
    console.log("\n  reason code               calls");
    console.log("  ─────────────────────────────────");
    for (const [reason, n] of [...histogram.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${reason.padEnd(24)}  ${String(n).padStart(5)}`);
    }
    console.log("\n  disposition                              calls");
    console.log("  ──────────────────────────────────────────────");
    for (const [label, n] of [...labels.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${label.padEnd(38)}  ${String(n).padStart(5)}`);
    }

    console.log(
        apply
            ? `\n[backfill:ai-touchpoints] inserted ${inserted} touchpoint(s).`
            : "\n[backfill:ai-touchpoints] dry run complete. Re-run with --apply to write.",
    );
    process.exit(0);
}

main().catch((err) => {
    console.error("[backfill:ai-touchpoints] failed:", err);
    process.exit(1);
});
