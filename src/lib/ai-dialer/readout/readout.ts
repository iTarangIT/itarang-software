// The nightly AI dialer quality readout (Priya KPI tracker task 5) — the pure half.
//
// The tracker's one target: COMPLETE CONVERSATIONS PER 100 DIALS. "A complete
// conversation is a human who heard Priya's question and whose call ended on
// purpose (a callback, a polite no, not a fit), not by a hang-up, a lag or a
// confusion." In Dispositions v3 words that is one of COMPLETE_L3.
//
// One readout row per IST dialling day:
//   Dials · Humans · Complete conversations · Per 100 dials ·
//   Humans gone in 15 s · Inbound answered
// plus, per call, the four defect flags the agent tasks are judged by:
//   intro restarted (task 2), a reply over 2 s (task 3), a language flip
//   (task 4), gone in 15 s (task 1 — the early-warning column).
//
// Pure: no database, no clock. The I/O is in readoutQuery.ts.

import { isHumanDisposition, languageFlipped } from "../dispositionV3";
import { parseTranscriptTurns } from "../call-quality/transcript";

/** "a callback, a polite no, not a fit". Apoorv to confirm the set. */
export const COMPLETE_L3: ReadonlySet<string> = new Set([
    "Information Collected", // a callback agreed
    "Ask to Call Back", // a callback asked for
    "Not Interested", // a polite no
    "REJECTED BY US", // not a fit
    "Some other Business", // not a fit (another trade)
]);

/** The early-warning column: a human gone inside this many seconds. */
export const GONE_SECS = 15;
/** A reply slower than this is a defect (tracker task 3: "Reply under 1 s"; 2 s is the flag). */
export const SLOW_REPLY_SECS = 2;

export type ReadoutTurn = {
    role: "agent" | "user";
    message: string;
    /** ElevenLabs convai_ttf_audio_since_silence: dealer quiet → Priya's first audio. */
    replySecs?: number | null;
};

export type ReadoutDial = {
    direction: "outbound" | "inbound";
    l1: string;
    l2: string;
    l3: string | null;
    rule: string;
    durationSecs: number | null;
    transcript?: string | null;
    turns?: ReadoutTurn[] | null;
    callLanguage?: string | null;
};

export type CallDefects = {
    introRestarts: number;
    slowReplies: number;
    agentReplies: number;
    languageFlip: boolean;
    goneIn15: boolean;
};

export function isCompleteConversation(d: Pick<ReadoutDial, "l1" | "l2" | "l3" | "rule">): boolean {
    return d.l1 === "Connected" && d.l3 != null && COMPLETE_L3.has(d.l3) && isHumanDisposition(d);
}

function words(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .replace(/[!-\/:-@\[-`{-~…।?¿¡]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 1),
    );
}

/** Jaccard overlap of two word sets. */
function overlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let both = 0;
    for (const w of a) if (b.has(w)) both++;
    return both / (a.size + b.size - both);
}

/**
 * How many times Priya started her introduction again (tracker task 2: "hello
 * / haan / ji are not interruptions; continue from where she stopped"). An
 * agent turn is a restart when it repeats at least half of the opener's words
 * (and the opener has five or more). The opener itself is not counted.
 */
export function introRestarts(turns: ReadonlyArray<{ role: string; message: string }>): number {
    const agent = turns.filter((t) => t.role === "agent" && t.message.trim());
    if (agent.length < 2) return 0;
    const opener = words(agent[0].message);
    if (opener.size < 5) return 0;
    return agent.slice(1).filter((t) => overlap(opener, words(t.message)) >= 0.5).length;
}

function turnsOf(d: ReadoutDial): ReadoutTurn[] {
    if (d.turns && d.turns.length) return d.turns;
    return parseTranscriptTurns(d.transcript).map((t) => ({
        role: t.speaker === "agent" ? "agent" : "user",
        message: t.text,
    }));
}

/** The four defect flags for one call. */
export function callDefects(d: ReadoutDial): CallDefects {
    const turns = turnsOf(d);
    // The opener has no "since silence" — only replies after the dealer spoke.
    const replies = turns.slice(1).filter((t) => t.role === "agent" && t.replySecs != null);
    const human = isHumanDisposition(d);
    return {
        introRestarts: introRestarts(turns),
        slowReplies: replies.filter((t) => (t.replySecs ?? 0) > SLOW_REPLY_SECS).length,
        agentReplies: replies.length,
        languageFlip: languageFlipped(d.transcript ?? turns.map((t) => `${t.role}: ${t.message}`).join("\n"), d.callLanguage),
        goneIn15: human && d.durationSecs != null && d.durationSecs < GONE_SECS,
    };
}

export type ReadoutRow = {
    day: string;
    dials: number;
    humans: number;
    complete: number;
    /** Complete per 100 dials, one decimal; null on a day with no dials. */
    per100: number | null;
    /** Humans gone in 15 s as a share of humans, whole percent; null with no humans. */
    gone15Pct: number | null;
    inboundTotal: number;
    inboundAnswered: number;
    /** Defect counts across the day's human calls. */
    defects: {
        introRestartCalls: number;
        slowReplyCalls: number;
        slowReplyTurnsPct: number | null;
        languageFlipCalls: number;
        goneIn15Calls: number;
    };
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function readoutRow(input: {
    day: string;
    dials: ReadonlyArray<ReadoutDial>;
    inbound: { total: number; answered: number };
}): ReadoutRow {
    const outbound = input.dials.filter((d) => d.direction === "outbound");
    const humans = outbound.filter((d) => isHumanDisposition(d));
    const complete = humans.filter(isCompleteConversation).length;
    const flags = humans.map(callDefects);
    const slowTurns = flags.reduce((a, f) => a + f.slowReplies, 0);
    const allTurns = flags.reduce((a, f) => a + f.agentReplies, 0);
    const gone = flags.filter((f) => f.goneIn15).length;
    return {
        day: input.day,
        dials: outbound.length,
        humans: humans.length,
        complete,
        per100: outbound.length ? round1((complete / outbound.length) * 100) : null,
        gone15Pct: humans.length ? Math.round((gone / humans.length) * 100) : null,
        inboundTotal: input.inbound.total,
        inboundAnswered: input.inbound.answered,
        defects: {
            introRestartCalls: flags.filter((f) => f.introRestarts > 0).length,
            slowReplyCalls: flags.filter((f) => f.slowReplies > 0).length,
            slowReplyTurnsPct: allTurns ? Math.round((slowTurns / allTurns) * 100) : null,
            languageFlipCalls: flags.filter((f) => f.languageFlip).length,
            goneIn15Calls: gone,
        },
    };
}

/** ElevenLabs transcript turns → ReadoutTurn (reply latency from the turn metrics). */
export function readoutTurnsFromProvider(raw: unknown): ReadoutTurn[] | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw
        .filter((t): t is Record<string, unknown> => t != null && typeof t === "object")
        .map((t) => {
            const metrics = (t.conversation_turn_metrics as { metrics?: Record<string, { elapsed_time?: number }> } | undefined)
                ?.metrics;
            const ttf = metrics?.convai_ttf_audio_since_silence?.elapsed_time;
            return {
                role: t.role === "agent" ? "agent" : "user",
                message: typeof t.message === "string" ? t.message : "",
                replySecs: typeof ttf === "number" && Number.isFinite(ttf) ? ttf : null,
            } satisfies ReadoutTurn;
        });
}

/** The readout as plain text lines (email body, console). Newest first. */
export function readoutLines(rows: ReadonlyArray<ReadoutRow>, meta: { version: string; changeTested: string }): string[] {
    const head = "Date        Dials  Humans  Complete  Per100  Gone<15s  Inbound";
    const body = rows.map((r) =>
        [
            r.day.padEnd(10),
            String(r.dials).padStart(6),
            String(r.humans).padStart(7),
            String(r.complete).padStart(9),
            (r.per100 == null ? "—" : r.per100.toFixed(1)).padStart(7),
            (r.gone15Pct == null ? "—" : `${r.gone15Pct}%`).padStart(9),
            `${r.inboundAnswered} of ${r.inboundTotal}`.padStart(9),
        ].join(" "),
    );
    const today = rows[0];
    const defects = today
        ? [
              "",
              `Today's defects (human calls): intro restarted ${today.defects.introRestartCalls}, ` +
                  `a reply over ${SLOW_REPLY_SECS} s ${today.defects.slowReplyCalls}` +
                  (today.defects.slowReplyTurnsPct == null ? "" : ` (${today.defects.slowReplyTurnsPct}% of replies)`) +
                  `, language flip ${today.defects.languageFlipCalls}, gone in ${GONE_SECS} s ${today.defects.goneIn15Calls}.`,
          ]
        : [];
    return [
        `Version: ${meta.version || "—"} · Change tested: ${meta.changeTested || "—"}`,
        "",
        head,
        ...body,
        ...defects,
        "",
        "Target: 15 per 100 dials by 15 Nov, 25 by 30 Nov. If 'Gone<15s' rises after a change, revert it the same day.",
    ];
}
