// ID 32 — the AI Analyst gets the CRM's agreed metric rules with every question.
//
// 13 Nov: the rules travel in the agent's own `instructions` field (POST /runs,
// agent 9316960), which reaches the model's system prompt only. They used to
// ride glued to the end of the question, which put them into the thread's
// title, its replayed history, the agent's memory and its table ranker, and
// into every reopened conversation. The question now goes as the user typed it.
//
// A question still gets the rules of the topics it is about ("revenue by
// salesperson last month" gets the revenue and people rules) plus the
// always-on ones; a question that names no topic gets every rule. Rules no
// longer compete with the question for room, so none is ever dropped.
//
// Runs asked before 13 Nov still have the rules inside their stored question:
// stripMetricRules takes them back off wherever a question or title is shown.

import { ANALYST_RULES, type AnalystTopic } from "@/lib/reports/metricDefinitions";

export { ANALYST_QUESTION_MAX } from "./questionLimit";

/** The agent's RunCreate.question maxLength. */
export const AGENT_QUESTION_MAX = 2000;
/** The agent's RunCreate.instructions maxLength. */
export const AGENT_INSTRUCTIONS_MAX = 12000;

/** What heads the rules in the agent's system prompt. */
export const INSTRUCTIONS_HEAD = "CRM metric rules - answer with these definitions:";

// The marker the rules were glued on with before 13 Nov. Only read now, to clean old runs.
export const LEGACY_RULES_MARK = " [CRM metric rules - answer with these definitions] ";
const MARK = LEGACY_RULES_MARK;

/** Words that put a question on a topic. Broad on purpose: a spare rule costs little, a missing one a wrong number. */
const TOPIC_WORDS: Record<AnalystTopic, RegExp> = {
    leads: /\blead|funnel|came in|enquir|inquir|source|\bready|unassigned|no owner|unowned|ownerless/i,
    calls: /\bcall|dial|engag|talk|spoke|neodove|\bhot\b|handed|transfer/i,
    quotes: /quot/i,
    won: /\bwon\b|\bwin|convert|closed|closing|\blost\b|\bloss/i,
    visits: /visit|field/i,
    business: /financ|battery sale|business type|segment|buyback|scrap/i,
    revenue: /revenue|sales value|billing|billed|invoice|turnover|₹|rupee|lakh|crore|\bcr\b|owed|outstanding|receivable|credit note|void|cancel|order/i,
    margin: /margin|profit|\bcost/i,
    batteries: /batter|\bunits?\b|\bsku|\bsold\b/i,
    people: /perform|salesperson|sales ?person|\breps?\b|\bisr|\basm|owner|\bteam|\bwho\b|best|\btop\b|each|leaderboard|per person|by person|target/i,
    trend: /\btrend|over time|month[- ]?(wise|on[- ]month|by[- ]month)|\bweek(ly|[- ]wise)\b|\bdaily\b|\bgrowth\b|\bgrow|forecast|\bproject|predict|next (two|2|few) months|last \d+ months/i,
    accounts: /account|gstin|\bgst\b|live dealer|active dealer|closed dealer|how many dealers|dealer (count|base)|churn/i,
    idle: /idle|stale|untouched|not worked|no work|sitting|needs attention|neglect|follow[- ]?up/i,
};

/** The topics a question is about. */
export function questionTopics(question: string): AnalystTopic[] {
    return (Object.keys(TOPIC_WORDS) as AnalystTopic[]).filter((t) => TOPIC_WORDS[t].test(question));
}

/** The rules for a question, in their written order, inside `room` characters, joined by `sep`. */
export function rulesForQuestion(question: string, room: number, sep = " "): string {
    const topics = new Set(questionTopics(question));
    const matched = ANALYST_RULES.filter((r) => r.topics.length === 0 || topics.size === 0 || r.topics.some((t) => topics.has(t)));
    // ID 184: a rule the question names exactly goes first (then written order).
    const named = matched.filter((r) => r.first?.test(question));
    const wanted = [...named, ...matched.filter((r) => !named.includes(r))];
    const picked: string[] = [];
    let used = -sep.length;
    for (const r of wanted) {
        if (used + sep.length + r.text.length > room) continue;
        picked.push(r.text);
        used += sep.length + r.text.length;
    }
    return picked.join(sep);
}

/** The `instructions` sent beside a question: the rules it needs, one per line, inside the agent's limit. */
export function metricInstructions(question: string, max = AGENT_INSTRUCTIONS_MAX): string {
    const room = max - INSTRUCTIONS_HEAD.length - 3; // "\n- " before the first rule
    const rules = rulesForQuestion(question, room, "\n- ");
    return rules ? `${INSTRUCTIONS_HEAD}\n- ${rules}` : "";
}

/**
 * The user's own question back from what the agent stored before 13 Nov — also
 * from a thread title cut part-way into the rules ("…how many? [CRM metric ru…").
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

/** A run as the browser may see it: its question without any old rules. */
export function cleanRun<T extends { question: string }>(run: T): T {
    return { ...run, question: stripMetricRules(run.question) };
}

/** A conversation as the browser may see it: its title without any old rules. */
export function cleanThread<T extends { title: string }>(thread: T): T {
    return { ...thread, title: stripMetricRules(thread.title) };
}
