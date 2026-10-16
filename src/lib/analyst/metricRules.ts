// ID 32 — the AI Analyst gets the CRM's agreed metric rules with every question.
//
// The agent (a separate service) takes only { connection_id, thread_id,
// question ≤ 2000 chars } — no system prompt or context field — so the rules
// ride AFTER the question. After, not before: the agent titles a thread from
// the start of its first question, which must stay the user's own words.
// The run, run-detail and thread routes strip them back off before anything
// reaches the browser.
//
// All the rules no longer fit beside a real question (revenue, margin,
// batteries and salesperson rules were added, ID 32), so a question carries
// the rules of the topics it is about — "revenue by salesperson last month"
// gets the revenue and people rules — plus the always-on ones. A question
// that names no topic gets every rule that fits. Questions are capped at
// ANALYST_QUESTION_MAX so the always-on rules always fit: never sent bare.

import { ANALYST_RULES, type AnalystTopic } from "@/lib/reports/metricDefinitions";

export { ANALYST_QUESTION_MAX } from "./questionLimit";

/** The agent's RunCreate.question maxLength. */
export const AGENT_QUESTION_MAX = 2000;

// One line, no newlines: the agent may fold whitespace when it makes a title.
const MARK = " [CRM metric rules - answer with these definitions] ";

/** Words that put a question on a topic. Broad on purpose: a spare rule costs little, a missing one a wrong number. */
const TOPIC_WORDS: Record<AnalystTopic, RegExp> = {
    leads: /lead|funnel|came in|enquir|inquir|source/i,
    calls: /call|dial|engag|talk|spoke|neodove|hot|handed|transfer/i,
    quotes: /quot/i,
    won: /won|win|convert|closed|closing|lost|loss/i,
    visits: /visit|field/i,
    business: /financ|battery sale|business type|segment|buyback|scrap/i,
    revenue: /revenue|sales value|billing|billed|invoice|turnover|₹|rupee|lakh|crore|cr|owed|outstanding|receivable|credit note|void|cancel|order/i,
    margin: /margin|profit|cost/i,
    batteries: /batter|units?|sku|sold/i,
    people: /perform|salesperson|sales ?person|reps?|isr|asm|owner|team|who|best|top|each|leaderboard|per person|by person|target/i,
    trend: /\btrend|over time|month[- ]?(wise|on[- ]month|by[- ]month)|\bweek(ly|[- ]wise)\b|\bdaily\b|\bgrowth\b|\bgrow|forecast|\bproject|predict|next (two|2|few) months|last \d+ months/i,
};

/** Room the rules get beside the longest allowed question (tests hold it). */
export const RULES_ROOM_AT_MAX = (questionMax: number) => AGENT_QUESTION_MAX - questionMax - MARK.length;

/** The topics a question is about. */
export function questionTopics(question: string): AnalystTopic[] {
    return (Object.keys(TOPIC_WORDS) as AnalystTopic[]).filter((t) => TOPIC_WORDS[t].test(question));
}

/** The rules for a question, in their written order, inside `room` characters. */
export function rulesForQuestion(question: string, room: number): string {
    const topics = new Set(questionTopics(question));
    const wanted = ANALYST_RULES.filter((r) => r.topics.length === 0 || topics.size === 0 || r.topics.some((t) => topics.has(t)));
    const picked: string[] = [];
    let used = -1;
    for (const r of wanted) {
        if (used + 1 + r.text.length > room) continue;
        picked.push(r.text);
        used += 1 + r.text.length;
    }
    return picked.join(" ");
}

/** The question as sent to the agent: with the rules it needs, inside the agent's limit. */
export function withMetricRules(question: string, max = AGENT_QUESTION_MAX): string {
    const room = max - question.length - MARK.length;
    if (room <= 0) return question;
    const rules = rulesForQuestion(question, room);
    return rules ? question + MARK + rules : question;
}

/**
 * The user's own question back from what the agent stored — also from a thread
 * title cut part-way into the rules ("…how many? [CRM metric ru…").
 */
export function stripMetricRules(text: string): string {
    const i = text.indexOf(MARK);
    if (i >= 0) return text.slice(0, i);
    const ellipsis = /(?:…|\.\.\.)$/.exec(text)?.[0] ?? "";
    const body = text.slice(0, text.length - ellipsis.length);
    for (let k = Math.min(MARK.length - 1, body.length); k >= 2; k--) {
        if (body.endsWith(MARK.slice(0, k))) return body.slice(0, body.length - k);
    }
    return text;
}
