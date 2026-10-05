// Red / amber / green for "% of target" cells in the digest emails (tracker
// ID 9). ONE set of thresholds for Sales Daily Blocks A, B and C:
//   green  ≥ 100%   amber  80–99%   red  < 80%
// Block A's headline ("behind target") uses the same amber floor.
//
// Pure, no imports: the email renderer (src/lib/email/sendDigestEmail.ts)
// applies it to the columns a DigestTable lists in `toneColumns`.

export type RagTone = "green" | "amber" | "red";

/** At or above this % of target is green. */
export const RAG_GREEN_MIN = 100;
/** At or above this (and below green) is amber; below it is red. */
export const RAG_AMBER_MIN = 80;

export function ragTone(pct: number | null | undefined): RagTone | null {
    if (pct == null || !Number.isFinite(pct)) return null;
    if (pct >= RAG_GREEN_MIN) return "green";
    if (pct >= RAG_AMBER_MIN) return "amber";
    return "red";
}

/**
 * Tone of a rendered cell such as "85%". Anything that is not a plain
 * percentage ("—", "Not measured yet", "") has no tone.
 */
export function ragToneOfCell(v: string | number | null | undefined): RagTone | null {
    if (typeof v === "number") return ragTone(v);
    if (typeof v !== "string") return null;
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*%\s*$/.exec(v);
    return m ? ragTone(Number(m[1])) : null;
}

/** Inline email colours per tone: text + light background (no stylesheet survives an email client). */
export const RAG_CELL_STYLE: Record<RagTone, { color: string; background: string }> = {
    green: { color: "#15803d", background: "#dcfce7" },
    amber: { color: "#b45309", background: "#fef3c7" },
    red: { color: "#b91c1c", background: "#fee2e2" },
};
