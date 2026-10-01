// Date sanity for proposed follow-ups and visits. The model resolves "kal 11
// baje" / "Monday"; the server refuses anything in the past or absurdly far
// out and asks instead of guessing. Stored instants are UTC ISO strings, the
// format the touchpoint writer's schema accepts.

import { istNow } from "../../prompt";

export const MAX_DAYS_AHEAD = 90;
const MIN_LEAD_MS = 2 * 60 * 1000;

export type WhenCheck<T> = { ok: true; value: T } | { ok: false; question: string };

/** A follow-up instant: in the future (≥ 2 min) and within 90 days. → UTC ISO. */
export function futureInstant(iso: string, now: Date): WhenCheck<string> {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { ok: false, question: "What date and time should the follow-up be?" };
    if (d.getTime() < now.getTime() + MIN_LEAD_MS) {
        return { ok: false, question: "That time has already passed. When should the follow-up be?" };
    }
    if (d.getTime() > now.getTime() + MAX_DAYS_AHEAD * 86_400_000) {
        return { ok: false, question: `That's more than ${MAX_DAYS_AHEAD} days away. Which date did you mean?` };
    }
    return { ok: true, value: d.toISOString() };
}

/** A visit day (IST calendar date): today or later, within 90 days. */
export function futureDay(date: string, now: Date): WhenCheck<string> {
    const today = istNow(now).isoDate;
    if (date < today) return { ok: false, question: "That date has already passed. Which day should the visit be?" };
    const limit = new Date(`${today}T00:00:00Z`);
    limit.setUTCDate(limit.getUTCDate() + MAX_DAYS_AHEAD);
    if (date > limit.toISOString().slice(0, 10)) {
        return { ok: false, question: `That's more than ${MAX_DAYS_AHEAD} days away. Which date did you mean?` };
    }
    return { ok: true, value: date };
}

/** An IST calendar day as the touchpoint's next-action instant (10:00 IST). */
export function dayToInstant(date: string): string {
    return new Date(`${date}T10:00:00+05:30`).toISOString();
}
