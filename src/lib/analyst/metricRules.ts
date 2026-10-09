// ID 32 — the AI Analyst gets the CRM's agreed metric rules with every question.
//
// The agent (a separate service) takes only { connection_id, thread_id,
// question ≤ 2000 chars } — no system prompt or context field — so the rules
// ride AFTER the question. After, not before: the agent titles a thread from
// the start of its first question, which must stay the user's own words.
// The run, run-detail and thread routes strip them back off before anything
// reaches the browser.

import { ANALYST_METRIC_RULES } from "@/lib/reports/metricDefinitions";

/** The agent's RunCreate.question maxLength. */
export const AGENT_QUESTION_MAX = 2000;

// One line, no newlines: the agent may fold whitespace when it makes a title.
const MARK = " [CRM metric rules - answer with these definitions] ";

/** The question as sent to the agent: with the rules when they fit, as asked otherwise. */
export function withMetricRules(question: string, max = AGENT_QUESTION_MAX): string {
    const full = question + MARK + ANALYST_METRIC_RULES;
    return full.length <= max ? full : question;
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
