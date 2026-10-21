// The lead's Overall Summary, written by the server (tracker ID 118 option B,
// Kartik 10 Oct): "the server writes the summary itself, refreshes it when a
// new call transcript arrives, and typed notes get their own field."
//
//   - refreshOverallSummary(id): reads the lead's calls — AI-call transcripts
//     (ai_call_logs) and, since 18 Oct (ID 118 item 2), NeoDove and manually
//     logged calls (their notes and outcome; an attached recording's
//     transcript) — and when one is newer than the summary last written
//     (dealer_leads.overall_summary_at, E-346) asks Gemini for a new one and
//     saves it. No key, no transcript, a model error → nothing changes.
//   - scheduleOverallSummaryRefresh(id): the same, fire-and-forget, after a
//     call touchpoint (src/lib/touchpoints/write.ts), a NeoDove call's
//     evidence (neodove/inbound.ts attachCallEvidence) or a transcribed
//     recording (ai/transcription/recordingQueue.ts). Debounced per lead.
//     Never blocks or fails the write that triggered it.
//
// Typed notes live in dealer_leads.summary_notes (E-346; Edit lead › Notes),
// so a refresh never overwrites what a person wrote. The first refresh on a
// lead keeps any summary saved before option B in summary_notes when that box
// is still empty, so no text written by hand before is lost.
//
// E-346 is NOT mirrored in schema.ts (dealer_leads is written by many Drizzle
// INSERTs that would fail on a database without it — same reason as E-236 /
// E-295); its columns are read through to_jsonb and written raw. Without E-346
// a refresh only fills an empty summary, as the lead page did before.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
    humanCallLabel,
    humanCallNote,
    joinTranscripts,
    latestSummaryInput,
    overallSummaryPrompt,
    summaryRefreshDue,
    SUMMARY_MAX_TRANSCRIPTS,
    type SummaryTranscript,
} from "@/lib/leads/overallSummaryRules";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

const GEMINI_MODEL = "gemini-2.5-flash";

/** Gemini's summary for the prompt, or null (no key, error, empty answer). Never throws. */
export async function generateOverallSummary(prompt: string): Promise<string | null> {
    const key = process.env.GEMINI_API_KEY_FOR_SUMMARY?.trim();
    if (!key) return null;
    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: AbortSignal.timeout(45_000),
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { maxOutputTokens: 2024, temperature: 0.3 },
                }),
            },
        );
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            console.error("[overall-summary] Gemini error:", res.status, JSON.stringify(err).slice(0, 300));
            return null;
        }
        const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        return text || null;
    } catch (err) {
        console.error("[overall-summary] Gemini call failed:", err instanceof Error ? err.message : err);
        return null;
    }
}

type LeadRow = {
    dealer_name: string | null;
    shop_name: string | null;
    location: string | null;
    overall_summary: string | null;
    /** E-346; absent (null key) on a database without it. */
    overall_summary_at: string | null;
    has_e346: boolean;
};

export type RefreshResult =
    | { status: "written"; summary: string }
    | { status: "current"; summary: string | null }
    | { status: "no_transcripts" | "no_lead" | "model_unavailable" | "kept_existing"; summary: string | null };

/**
 * ID 118 item 2 (18 Oct): the lead's human calls, as summary input —
 *   * inside-sales call touchpoints (NeoDove, or logged by the rep): their
 *     notes, status and NeoDove disposition (humanCallNote; nothing when the
 *     call carries no remarks and no disposition);
 *   * recordings attached as a human call (E-250) once transcribed: the
 *     transcript.
 * `seenAt` is when the CRM got the text, so a replayed old NeoDove call or a
 * transcript finished later still makes the summary due. The disposition is
 * read through to_jsonb (E-226/E-236 may be missing); a database without
 * E-250 just has no recordings. Never throws.
 */
async function humanCallInputs(dealerLeadId: string): Promise<SummaryTranscript[]> {
    const out: SummaryTranscript[] = [];
    try {
        const rows = rowsOf<{
            at: string;
            seen_at: string;
            external_system: string | null;
            call_status: string | null;
            disposition: string | null;
            remarks: string | null;
            duration: number | null;
        }>(
            await db.execute(sql`
                SELECT t.performed_at AS at, COALESCE(t.created_at, t.performed_at) AS seen_at,
                       t.external_system, t.call_status, t.remarks, t.call_duration_sec AS duration,
                       to_jsonb(t) ->> 'disposition' AS disposition
                  FROM lead_touchpoints t
                 WHERE t.dealer_lead_id = ${dealerLeadId} AND t.touchpoint_type = 'inside_sales_call'
                   AND (COALESCE(btrim(t.remarks), '') <> '' OR COALESCE(btrim(to_jsonb(t) ->> 'disposition'), '') <> '')
                 ORDER BY t.performed_at DESC
                 LIMIT ${SUMMARY_MAX_TRANSCRIPTS}
            `),
        );
        for (const r of rows) {
            const source = r.external_system === "neodove" ? "neodove" : "manual";
            const note = humanCallNote({
                source,
                callStatus: r.call_status,
                disposition: r.disposition,
                remarks: r.remarks,
                durationSec: r.duration == null ? null : Number(r.duration),
            });
            if (note) out.push({ at: new Date(r.at), seenAt: new Date(r.seen_at), transcript: note, label: humanCallLabel(source) });
        }
    } catch (err) {
        console.warn("[overall-summary] human calls not read:", err instanceof Error ? err.message : err);
    }
    try {
        const recs = rowsOf<{ at: string; seen_at: string; transcript: string }>(
            await db.execute(sql`
                SELECT created_at AS at, COALESCE(transcribed_at, created_at) AS seen_at, transcript
                  FROM lead_call_recordings
                 WHERE lead_id = ${dealerLeadId} AND purpose = 'human_call' AND status = 'done'
                   AND transcript IS NOT NULL AND btrim(transcript) <> ''
                 ORDER BY created_at DESC
                 LIMIT ${SUMMARY_MAX_TRANSCRIPTS}
            `),
        );
        for (const r of recs) {
            out.push({ at: new Date(r.at), seenAt: new Date(r.seen_at), transcript: r.transcript, label: humanCallLabel("recording") });
        }
    } catch {
        // E-250 not applied: no attached recordings.
    }
    return out;
}

/**
 * The refresh queue, one entry per lead: a pending timer is pushed back by a
 * new call (debounce), and a call arriving while a refresh runs makes it run
 * once more after — so the evidence that landed mid-run is not lost.
 */
const queue = new Map<string, { timer: ReturnType<typeof setTimeout> | null; running: boolean; again: boolean }>();

/**
 * Write a fresh summary when a transcript is newer than the last one written.
 * `force` regenerates even when it is current (the lead page asking for one).
 */
export async function refreshOverallSummary(dealerLeadId: string, opts: { force?: boolean } = {}): Promise<RefreshResult> {
    const [lead] = rowsOf<LeadRow>(
        await db.execute(sql`
            SELECT dealer_name, shop_name, location, overall_summary,
                   to_jsonb(dl) ->> 'overall_summary_at' AS overall_summary_at,
                   (to_jsonb(dl) ? 'overall_summary_at') AS has_e346
              FROM dealer_leads dl WHERE id = ${dealerLeadId} LIMIT 1
        `),
    );
    if (!lead) return { status: "no_lead", summary: null };

    const aiCalls = rowsOf<{ at: string; transcript: string }>(
        await db.execute(sql`
            SELECT COALESCE(ended_at, created_at) AS at, transcript
              FROM ai_call_logs
             WHERE lead_id = ${dealerLeadId} AND transcript IS NOT NULL AND btrim(transcript) <> ''
             ORDER BY COALESCE(ended_at, created_at) DESC
             LIMIT ${SUMMARY_MAX_TRANSCRIPTS}
        `),
    ).map((c): SummaryTranscript => ({ at: new Date(c.at), transcript: c.transcript }));
    // ID 118 item 2 (18 Oct): NeoDove and manually logged calls feed it too.
    const calls = [...aiCalls, ...(await humanCallInputs(dealerLeadId))];
    if (calls.length === 0) return { status: "no_transcripts", summary: lead.overall_summary };

    const latest = latestSummaryInput(calls);
    const writtenAt = lead.overall_summary_at ? new Date(lead.overall_summary_at) : null;
    if (!opts.force && !summaryRefreshDue(latest, writtenAt)) return { status: "current", summary: lead.overall_summary };
    // Without E-346 nothing tells a typed summary from a written one: only fill an empty one.
    if (!lead.has_e346 && (lead.overall_summary ?? "").trim()) {
        return { status: "kept_existing", summary: lead.overall_summary };
    }

    const summary = await generateOverallSummary(
        overallSummaryPrompt({
            transcripts: joinTranscripts(calls),
            dealerName: lead.dealer_name,
            shopName: lead.shop_name,
            location: lead.location,
        }),
    );
    if (!summary) return { status: "model_unavailable", summary: lead.overall_summary };

    if (lead.has_e346) {
        // updated_at is left alone on purpose: it is the ageing clock on the
        // sales screens, and a machine-written summary is not activity.
        await db.execute(sql`
            UPDATE dealer_leads
               SET summary_notes = CASE
                       WHEN overall_summary_at IS NULL
                        AND COALESCE(btrim(summary_notes), '') = ''
                        AND COALESCE(btrim(overall_summary), '') <> ''
                       THEN overall_summary ELSE summary_notes END,
                   overall_summary = ${summary},
                   overall_summary_at = now()
             WHERE id = ${dealerLeadId}
        `);
    } else {
        await db.execute(sql`
            UPDATE dealer_leads SET overall_summary = ${summary}
             WHERE id = ${dealerLeadId} AND COALESCE(btrim(overall_summary), '') = ''
        `);
    }
    return { status: "written", summary };
}

/**
 * After a call — an AI call or a manually logged one (writeTouchpoint), a
 * NeoDove call once its disposition and recording are stored
 * (attachCallEvidence), a recording transcribed (recordingQueue) — refresh in
 * the background. The short delay lets the caller's transaction commit and the
 * call's text land first; a second call for the same lead within the delay
 * pushes it back (one refresh), and one arriving while a refresh runs makes it
 * run once more, forced, after. Off in tests, with OVERALL_SUMMARY_AUTO=0, or
 * without the Gemini key.
 */
export function scheduleOverallSummaryRefresh(dealerLeadId: string, delayMs = 3_000): void {
    if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") return;
    if ((process.env.OVERALL_SUMMARY_AUTO ?? "").trim() === "0") return;
    if (!process.env.GEMINI_API_KEY_FOR_SUMMARY?.trim()) return;

    const entry = queue.get(dealerLeadId) ?? { timer: null, running: false, again: false };
    queue.set(dealerLeadId, entry);
    if (entry.running) {
        entry.again = true;
        return;
    }
    if (entry.timer) clearTimeout(entry.timer);

    const run = (force: boolean) => {
        entry.timer = null;
        entry.running = true;
        entry.again = false;
        refreshOverallSummary(dealerLeadId, { force })
            .then((r) => {
                if (r.status === "written") console.log(`[overall-summary] refreshed ${dealerLeadId}`);
            })
            .catch((err) => console.error(`[overall-summary] refresh failed for ${dealerLeadId}:`, err instanceof Error ? err.message : err))
            .finally(() => {
                entry.running = false;
                // A call that landed mid-run may be older than the summary just
                // written — so the rerun is forced, not judged by time.
                if (entry.again) run(true);
                else queue.delete(dealerLeadId);
            });
    };
    entry.timer = setTimeout(() => run(false), delayMs);
    // Never keep a script (backfills call writeTouchpoint) alive for this.
    (entry.timer as { unref?: () => void }).unref?.();
}
