// ID 227 — run a job once per IST day from a given time, across processes and
// restarts. The digest_runs claim that dispatch-to-sold (ID 220), the Drive
// 08:30 scan and the morning monitor already use, as one helper: a ticker can
// fire every 5 minutes and only the first due tick of the day does the work.
//
// No migration: digest_runs (E-287/E-288) has a partial UNIQUE on
// (kind, digest_date, slot) for the 'morning' / 'evening' slots.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { istSlotState, type Slot } from "@/lib/monitor/schedule";

const SLOT_NAME = "morning";
const MAX_ATTEMPTS = 6;
const STUCK_CLAIM_MINUTES = 30;

async function claim(kind: string, istDate: string): Promise<number | null> {
  const rows = (await db.execute(sql`
    INSERT INTO digest_runs (kind, digest_date, slot, status, attempts, triggered_by, recipients, claimed_at)
    VALUES (${kind}, ${istDate}::date, ${SLOT_NAME}, 'sending', 1, 'ticker', 'system', now())
    ON CONFLICT (kind, digest_date, slot) WHERE slot IN ('morning', 'evening')
    DO UPDATE SET status = 'sending', attempts = digest_runs.attempts + 1, claimed_at = now()
    WHERE (digest_runs.status = 'failed' AND digest_runs.attempts < ${MAX_ATTEMPTS})
       OR (digest_runs.status = 'sending'
           AND digest_runs.claimed_at < now() - make_interval(mins => ${STUCK_CLAIM_MINUTES}))
    RETURNING id
  `)) as unknown as Array<{ id: number }>;
  return rows?.[0]?.id ?? null;
}

export type DailyJobOutcome =
  | { ran: false; reason: "not_due" | "already_claimed" }
  | { ran: true; istDate: string; counts: Record<string, unknown>; failed: boolean };

/**
 * Claim today's run of `kind` once the IST `slot` time has passed, run `fn`,
 * and record its counts. `fn` reports partial failure by returning
 * `{ failed: true }` in its counts; a throw marks the day failed (retried by a
 * later tick, up to MAX_ATTEMPTS).
 */
export async function runOncePerIstDay(
  kind: string,
  slot: Slot,
  fn: () => Promise<Record<string, unknown>>,
  now: Date = new Date(),
): Promise<DailyJobOutcome> {
  const state = istSlotState(now, slot);
  if (!state.due) return { ran: false, reason: "not_due" };
  const runId = await claim(kind, state.istDate);
  if (runId === null) return { ran: false, reason: "already_claimed" };
  let status: "sent" | "failed" = "sent";
  let error: string | null = null;
  let counts: Record<string, unknown> = {};
  try {
    counts = await fn();
    if (counts.failed === true) {
      status = "failed";
      error = typeof counts.error === "string" ? counts.error : "one or more steps failed";
    }
    return { ran: true, istDate: state.istDate, counts, failed: status === "failed" };
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await db
      .execute(
        sql`UPDATE digest_runs SET status = ${status}, error = ${error}, counts = ${JSON.stringify(counts)}::jsonb WHERE id = ${runId}`,
      )
      .catch((e: unknown) => console.error(`[daily-job:${kind}] outcome not recorded:`, e instanceof Error ? e.message : e));
  }
}
