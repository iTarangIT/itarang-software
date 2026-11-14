// AI Analyst — starter questions for an empty conversation, personalised by what the caller
// has asked before. Client-safe.

import { normalizeQuestion } from "./verified";

export type Starter = { question: string; personal: boolean };

/** The business questions the CEO and Sales Head actually ask (13 Nov). */
export const DEFAULT_STARTERS = [
    "How many visits did each ASM make this week?",
    "Revenue this month vs last month, by salesperson",
    "How many leads came in today, by source?",
    "Which dealers have not placed an order in the last 30 days?",
];

/**
 * `asked` is the caller's own questions, newest first (repeats included). A question asked
 * twice or more comes first (most asked, then most recent); then the latest distinct ones;
 * the rest of the `n` slots are the defaults. At most `n - 1` are personal, so one default
 * always shows a new user what else can be asked.
 */
export function personalStarters(asked: string[], defaults: string[] = DEFAULT_STARTERS, n = 4): Starter[] {
    const groups = new Map<string, { question: string; count: number; first: number }>();
    asked.forEach((raw, i) => {
        const question = raw.replace(/\s+/g, " ").trim();
        if (question.length < 8 || question.length > 140) return;
        const key = normalizeQuestion(question);
        if (!key) return;
        const g = groups.get(key);
        if (g) g.count++;
        else groups.set(key, { question, count: 1, first: i });
    });

    const ranked = [...groups.values()].sort((a, b) => b.count - a.count || a.first - b.first);
    const personal = ranked.slice(0, Math.max(0, n - 1)).map((g) => ({ question: g.question, personal: true }));

    const taken = new Set(personal.map((p) => normalizeQuestion(p.question)));
    const rest = defaults
        .filter((d) => !taken.has(normalizeQuestion(d)))
        .slice(0, n - personal.length)
        .map((question) => ({ question, personal: false }));
    return [...personal, ...rest];
}
