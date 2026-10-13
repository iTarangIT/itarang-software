// ID 32 — the longest question the AI Analyst takes. Client-safe (no imports),
// so the composer can count against it. The agent's own limit is 2,000
// characters and the CRM metric rules ride after the question
// (metricRules.ts); 1,200 leaves ~750 characters for the rules a question
// needs. metricRules.test.ts holds it to that.
export const ANALYST_QUESTION_MAX = 1200;
