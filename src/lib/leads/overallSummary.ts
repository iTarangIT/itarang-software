// The lead's Overall Summary, written by the server (tracker ID 118 option B,
// Kartik 10 Oct): "the server writes the summary itself, refreshes it when a
// new call transcript arrives, and typed notes get their own field."
//
//   - refreshOverallSummary(id): reads the lead's call transcripts
//     (ai_call_logs), and when one is newer than the summary last written
//     (dealer_leads.overall_summary_at, E-346) asks Gemini for a new one and
//     saves it. No key, no transcript, a model error → nothing changes.
//   - scheduleOverallSummaryRefresh(id): the same, fire-and-forget, after a
//     call touchpoint (src/lib/touchpoints/write.ts). Never blocks or fails the
//     write that triggered it.
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
    joinTranscripts,
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

const inFlight = new Set<string>();

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

    const calls = rowsOf<{ at: string; transcript: string }>(
        await db.execute(sql`
            SELECT COALESCE(ended_at, created_at) AS at, transcript
              FROM ai_call_logs
             WHERE lead_id = ${dealerLeadId} AND transcript IS NOT NULL AND btrim(transcript) <> ''
             ORDER BY COALESCE(ended_at, created_at) DESC
             LIMIT ${SUMMARY_MAX_TRANSCRIPTS}
        `),
    ).map((c): SummaryTranscript => ({ at: new Date(c.at), transcript: c.transcript }));
    if (calls.length === 0) return { status: "no_transcripts", summary: lead.overall_summary };

    const latest = calls[0].at;
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
 * After a call touchpoint: refresh in the background. The short delay lets
 * the caller's transaction commit (writeTouchpoint can run inside one) and the
 * call log row land first. One refresh per lead at a time. Off in tests, with
 * OVERALL_SUMMARY_AUTO=0, or without the Gemini key.
 */
export function scheduleOverallSummaryRefresh(dealerLeadId: string, delayMs = 3_000): void {
    if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") return;
    if ((process.env.OVERALL_SUMMARY_AUTO ?? "").trim() === "0") return;
    if (!process.env.GEMINI_API_KEY_FOR_SUMMARY?.trim()) return;
    if (inFlight.has(dealerLeadId)) return;
    inFlight.add(dealerLeadId);
    const timer = setTimeout(() => {
        refreshOverallSummary(dealerLeadId)
            .then((r) => {
                if (r.status === "written") console.log(`[overall-summary] refreshed ${dealerLeadId}`);
            })
            .catch((err) => console.error(`[overall-summary] refresh failed for ${dealerLeadId}:`, err instanceof Error ? err.message : err))
            .finally(() => inFlight.delete(dealerLeadId));
    }, delayMs);
    // Never keep a script (backfills call writeTouchpoint) alive for this.
    (timer as { unref?: () => void }).unref?.();
}
