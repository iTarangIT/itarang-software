// ID 224: a lead NeoDove creates must not start AFTER its own first call.
//
// NeoDove's call event (and its LEAD_CREATE) reaches us about an hour after
// the call; the lead used to be stamped with the arrival time, so 182 lead
// timelines on live began after their first call. The lead is dated at the
// event's own time instead — pure rule here, the writes in inbound.ts.

/** How far back an event time is trusted (older = a replay or a bad clock). */
export const MAX_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000;

/** When a NeoDove-born lead came in: the event's time when sane, else now. */
export function neodoveBornAt(occurredAt: Date | null | undefined, now: Date = new Date()): Date {
    if (!occurredAt || Number.isNaN(occurredAt.getTime())) return now;
    if (occurredAt.getTime() > now.getTime()) return now; // never in the future
    if (now.getTime() - occurredAt.getTime() > MAX_BACKDATE_MS) return now;
    return occurredAt;
}
