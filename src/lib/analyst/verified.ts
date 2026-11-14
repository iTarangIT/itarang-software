// AI Analyst — verified queries (E-382), the pure half. Client-safe: no imports.
//
// A verified query is a run's SQL that the CEO / Sales Head checked and marked good. Two jobs:
//  1. Reuse: a new question close enough to a verified one is sent to the agent with that SQL
//     in its `instructions`, so the agent starts from the known-good query.
//  2. Badge: an answer whose final SQL is (after normalising) a verified query is "Verified".

/** Lower case, comments and extra spacing gone, no trailing semicolon. String literals kept as typed. */
export function normalizeSql(sql: string): string {
    // Literals are set aside while spacing is normalised, then put back untouched.
    const literals: string[] = [];
    let out = "";
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        // A quoted literal or identifier is copied as-is: 'Delhi' and 'delhi' are different queries.
        if (ch === "'" || ch === '"') {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === ch) {
                    if (sql[j + 1] === ch) {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j++;
            }
            literals.push(sql.slice(i, j + 1));
            // A placeholder no SQL keyword or identifier can look like; the literal goes back below.
            out += ` @@lit${literals.length - 1}@@ `;
            i = j + 1;
            continue;
        }
        if (ch === "-" && sql[i + 1] === "-") {
            const end = sql.indexOf("\n", i);
            i = end === -1 ? sql.length : end;
            out += " ";
            continue;
        }
        if (ch === "/" && sql[i + 1] === "*") {
            const end = sql.indexOf("*/", i + 2);
            i = end === -1 ? sql.length : end + 2;
            out += " ";
            continue;
        }
        out += /\s/.test(ch) ? " " : ch.toLowerCase();
        i++;
    }
    return out
        .replace(/\s+/g, " ")
        .replace(/\s*([(),=<>+*/-])\s*/g, "$1")
        .trim()
        .replace(/;+\s*$/, "")
        .trim()
        .replace(/@@lit(\d+)@@/g, (_, n: string) => literals[Number(n)]);
}

/** Words that say nothing about what is being asked. */
const STOPWORDS = new Set(
    "a an and are as at be by can did do does for from give have how i in is it me my of on or our please show tell than that the their there these this to us was we were what when which who with you your".split(
        " ",
    ),
);

/** Lower case, punctuation gone, stopwords dropped, crude plural fold ("leads" → "lead"). */
export function questionTokens(question: string): string[] {
    return question
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w && !STOPWORDS.has(w))
        .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

export function normalizeQuestion(question: string): string {
    return questionTokens(question).join(" ");
}

/** Jaccard overlap of the two questions' tokens, 0..1. */
export function questionSimilarity(a: string, b: string): number {
    const x = new Set(questionTokens(a));
    const y = new Set(questionTokens(b));
    if (x.size === 0 || y.size === 0) return 0;
    let both = 0;
    for (const w of x) if (y.has(w)) both++;
    return both / (x.size + y.size - both);
}

/** How close a question must be to a verified one for its SQL to be offered. */
export const VERIFIED_MATCH_MIN = 0.6;

export type VerifiedCandidate = { id: string; question: string; sql: string };
export type VerifiedMatch = VerifiedCandidate & { score: number };

/** The best `k` verified queries for a question, closest first, at or above the threshold. */
export function rankVerified(question: string, candidates: VerifiedCandidate[], k = 3): VerifiedMatch[] {
    return candidates
        .map((c) => ({ ...c, score: questionSimilarity(question, c.question) }))
        .filter((c) => c.score >= VERIFIED_MATCH_MIN)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
}

export const VERIFIED_HEAD =
    "Verified queries for similar questions - these were checked by the CEO / Sales Head. Reuse the closest one, changing only what the new question changes (period, person, filter):";

/** The block appended to the run's `instructions`, inside `room` characters; "" when nothing fits. */
export function verifiedInstructions(matches: VerifiedMatch[], room: number): string {
    let out = "";
    for (const m of matches) {
        const block = `\n- Question: ${m.question}\n  SQL: ${m.sql.replace(/\s+/g, " ").trim()}`;
        const head = out ? "" : VERIFIED_HEAD;
        if (head.length + out.length + block.length > room) continue;
        out = (out || head) + block;
    }
    return out;
}

/** The run's `instructions`: metric rules first, then the verified queries in what room is left. */
export function joinInstructions(rules: string, matches: VerifiedMatch[], max: number): string {
    const sep = rules ? "\n\n" : "";
    const verified = verifiedInstructions(matches, max - rules.length - sep.length);
    return verified ? `${rules}${sep}${verified}` : rules;
}
