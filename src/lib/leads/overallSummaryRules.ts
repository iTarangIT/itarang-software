// The lead's Overall Summary, option B (tracker ID 118, decided by Kartik on
// 10 Oct): "the server writes the summary itself, refreshes it when a new call
// transcript arrives, and typed notes get their own field."
//
// Pure half: which transcripts go in, the prompt, and when a refresh is due.
// No db, no network, so it unit-tests alone. overallSummary.ts does the work.

export type SummaryTranscript = { at: Date; transcript: string };

/** The newest transcripts the summary reads (older calls are already in it). */
export const SUMMARY_MAX_TRANSCRIPTS = 12;
/** Cap on the text sent to the model, newest calls kept. */
export const SUMMARY_MAX_CHARS = 40_000;

/**
 * Due when there is a transcript newer than the last summary the server wrote.
 * No summary written yet (null) → due as soon as there is any transcript.
 */
export function summaryRefreshDue(latestTranscriptAt: Date | null, summaryWrittenAt: Date | null): boolean {
    if (!latestTranscriptAt) return false;
    if (!summaryWrittenAt) return true;
    return latestTranscriptAt.getTime() > summaryWrittenAt.getTime();
}

/** Oldest-first transcript block, newest SUMMARY_MAX_TRANSCRIPTS calls, within SUMMARY_MAX_CHARS. */
export function joinTranscripts(calls: readonly SummaryTranscript[]): string {
    const usable = calls
        .filter((c) => c.transcript && c.transcript.trim())
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .slice(-SUMMARY_MAX_TRANSCRIPTS);
    const blocks = usable.map(
        (c, i) =>
            `--- Call ${i + 1} (${c.at.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}) ---\n${c.transcript.trim()}`,
    );
    // Keep the newest calls whole: drop the oldest blocks until it fits.
    while (blocks.length > 1 && blocks.join("\n\n").length > SUMMARY_MAX_CHARS) blocks.shift();
    const text = blocks.join("\n\n");
    return text.length > SUMMARY_MAX_CHARS ? text.slice(-SUMMARY_MAX_CHARS) : text;
}

/** The prompt (same wording the lead page used when it generated the summary in the browser). */
export function overallSummaryPrompt(input: {
    transcripts: string;
    dealerName?: string | null;
    shopName?: string | null;
    location?: string | null;
}): string {
    return `You are analyzing sales call transcripts between Vikram (sales agent from iTarang Technologies) and a dealer named ${input.dealerName || "the dealer"} from ${input.shopName || "their shop"} in ${input.location || "an unknown location"}.

Here are all the call transcripts in chronological order:

${input.transcripts}

Write a concise overall summary (4-6 sentences) of the entire conversation history. Cover:
- What has been discussed across all calls
- The dealer's interest level and any concerns raised
- Where things currently stand
- What would be the logical next step

Be direct and factual. Write in third person. Plain paragraph only, no bullet points. Always write a complete, finished paragraph — do not cut off mid-sentence.`;
}

/** Touchpoint kinds that are a call — the ones after which a refresh may be due. */
export const SUMMARY_CALL_TOUCHPOINTS = ["ai_call", "inside_sales_call"] as const;

export function isSummaryCallTouchpoint(type: string): boolean {
    return (SUMMARY_CALL_TOUCHPOINTS as readonly string[]).includes(type);
}
