// AI Analyst — follow-up questions offered under an answer. Client-safe: no imports.
//
// Rule-based on purpose: no extra model call, no extra budget, and the same answer always
// offers the same follow-ups. Each chip sends a full question (not "same for yesterday"), so
// it reads correctly in the transcript and does not depend on the agent's thread memory.

export type FollowUp = { label: string; question: string };

const PERIOD_SWAPS: [RegExp, string, string][] = [
    [/\btoday\b/i, "yesterday", "Same for yesterday"],
    [/\byesterday\b/i, "today", "Same for today"],
    [/\bthis week\b/i, "last week", "Same for last week"],
    [/\blast week\b/i, "this week", "Same for this week"],
    [/\bthis month\b/i, "last month", "Same for last month"],
    [/\blast month\b/i, "this month", "Same for this month"],
    [/\bthis quarter\b/i, "last quarter", "Same for last quarter"],
    [/\bthis year\b/i, "last year", "Same for last year"],
    [/\blast year\b/i, "this year", "Same for this year"],
];

const ANY_PERIOD =
    /\btoday\b|\byesterday\b|\b(this|last|next|previous)\s+(week|month|quarter|year)\b|\blast \d+ (days|weeks|months)\b|\bsince\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b20\d\d\b|\bmtd\b|\bytd\b/i;
const PEOPLE = /salesperson|sales ?person|\breps?\b|\bisr|\basm|owner|\bteam\b|\bwho\b|each person|by person|per person|employee|staff|executive/i;
const LEADS = /\blead|enquir|inquir|funnel/i;
const DEALERS = /dealer|account|customer|shop/i;
const COUNTING = /^\s*(how many|count|number of|total)\b|\bhow many\b|\bcount\b|\bnumber of\b|\btotal\b/i;
const REVENUE = /revenue|sales value|billing|billed|invoice|turnover|collection|outstanding|receivable/i;
const COMPARING = /\bvs\.?\b|versus|compare|compared|against/i;
const BY_SOURCE = /\bsource\b/i;
const BY_PLACE = /\bcity|\bstate\b|\bregion|\barea\b|\bdistrict|\bzone/i;

const PEOPLE_COLUMN = /name|owner|salesperson|rep|asm|isr|user|employee|staff|assigned/i;

function strip(question: string): string {
    return question.trim().replace(/[?.!\s]+$/, "");
}

/** Up to three follow-ups for a finished answer. `columns` are the result's, when known. */
export function followUps(question: string, columns: string[] = [], max = 3): FollowUp[] {
    const q = strip(question);
    if (q.length < 3) return [];
    const out: FollowUp[] = [];
    const push = (label: string, next: string) => {
        if (out.length >= max) return;
        if (next.toLowerCase() === question.trim().toLowerCase()) return;
        if (out.some((f) => f.label === label || f.question === next)) return;
        out.push({ label, question: next });
    };

    // 1. The same question for the neighbouring period.
    const swap = PERIOD_SWAPS.find(([re]) => re.test(q));
    if (swap) {
        const [re, to, label] = swap;
        push(label, q.replace(re, to) + "?");
    } else if (!ANY_PERIOD.test(q)) {
        push("Same for this month", `${q}, for this month?`);
    }

    // 2. Split by salesperson, unless it already is by person.
    const byPerson = PEOPLE.test(q) || columns.some((c) => PEOPLE_COLUMN.test(c));
    if (!byPerson) push("Split by salesperson", `${q}, split by salesperson?`);

    // 3. The rows behind a count.
    const counting = COUNTING.test(q) && !REVENUE.test(q);
    if (counting && LEADS.test(q)) push("Show the leads", `Show the leads behind this: ${q}`);
    else if (counting && DEALERS.test(q)) push("Show the dealers", `Show the dealers behind this: ${q}`);

    // 4. Another useful cut.
    if (REVENUE.test(q) && !COMPARING.test(q)) push("Compare with last month", `${q}, compared with last month?`);
    if (LEADS.test(q) && !BY_SOURCE.test(q)) push("Split by source", `${q}, split by lead source?`);
    if (!BY_PLACE.test(q) && !columns.some((c) => /city|state/i.test(c))) push("Split by city", `${q}, split by city?`);

    return out;
}
