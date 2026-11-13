// ID 32 — the longest question the AI Analyst takes. Client-safe (no imports),
// so the composer can count against it. Since 13 Nov the CRM metric rules go
// in the agent's separate `instructions` field (metricRules.ts), so a question
// gets the agent's whole 2,000-character limit.
export const ANALYST_QUESTION_MAX = 2000;
