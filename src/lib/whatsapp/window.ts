// Meta's 24-hour customer-service window.
//
// Until now nothing in the codebase READ this. `last_inbound_at` is written in
// six places across the three orchestrators and only ever displayed in the admin
// conversation view — so every out-of-band send was free-form and simply hoped
// the window was open. src/lib/whatsapp/notifications.ts says so out loud.
//
// That was survivable while the only out-of-band sends were consent push-backs
// moments after the dealer had been typing. It stops being survivable once the
// journey sends "your loan is sanctioned" days later.
//
// The rule Meta enforces: inside 24h of the customer's last inbound message we
// may send anything; outside it we may send only a pre-approved template. Note
// what does NOT happen — sending a template does not re-open the window. Only
// the customer's reply does. That asymmetry is why callers must PARK the real
// interactive prompt and replay it on the next inbound, rather than sending a
// template and immediately following up.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { whatsappOnboardingSessions } from "@/lib/db/schema";
import type { SessionRow } from "./session-store";

export const WA_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Subtracted from the window before we call it open. A send begun at 23:59:50
 * can be delivered to Meta after the boundary and rejected with 131047, and the
 * caller would have already discarded its template fallback. Five minutes costs
 * us nothing — the alternative is a message the customer never sees.
 */
export const WA_WINDOW_SAFETY_MS = Number(
  process.env.WA_WINDOW_SAFETY_MS ?? 5 * 60 * 1000,
);

/**
 * Meta scores a business down for template messages that go unanswered, and a
 * poor quality rating throttles the number. Three unanswered nudges is where we
 * stop ringing the bell and wait for the customer (or the dealer) to act.
 */
export const WA_MAX_WINDOW_NUDGES = Number(
  process.env.WA_MAX_WINDOW_NUDGES ?? 3,
);

export function inServiceWindow(
  session: Pick<SessionRow, "last_inbound_at">,
  now: Date = new Date(),
): boolean {
  const last = session.last_inbound_at?.getTime();
  if (!last) return false;
  return now.getTime() - last < WA_WINDOW_MS - WA_WINDOW_SAFETY_MS;
}

/** Milliseconds until the window shuts; 0 when it is already shut. */
export function windowRemainingMs(
  session: Pick<SessionRow, "last_inbound_at">,
  now: Date = new Date(),
): number {
  const last = session.last_inbound_at?.getTime();
  if (!last) return 0;
  return Math.max(0, last + WA_WINDOW_MS - WA_WINDOW_SAFETY_MS - now.getTime());
}

/**
 * Meta rejects a template whose body parameter contains a newline, a tab, or a
 * run of four or more spaces. Every param we interpolate is user- or
 * DB-derived — a customer name pasted with a line break, an address, a product
 * label — so this is not a theoretical guard. One place, so the rule stops
 * being re-discovered per call site.
 */
export function oneLine(value: string, max = 220): string {
  const flat = (value ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Reset the nudge counter. Called when the customer comes back — their inbound
 * is what re-opens the window, so the budget starts again.
 */
export async function resetWindowNudges(sessionId: string): Promise<void> {
  await db
    .update(whatsappOnboardingSessions)
    .set({ window_nudges_sent: 0 })
    .where(sql`${whatsappOnboardingSessions.id} = ${sessionId}`);
}
