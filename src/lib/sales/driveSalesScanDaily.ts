/**
 * The daily 08:30 IST invoice scan (tracker ID 9).
 *
 * The Drive sales scan runs every six hours, so the Daily Sales email at 09:00
 * could read Revenue up to six hours stale. This adds ONE scan per IST day
 * from 08:30, so Revenue is at most ~30 minutes old when the mail is built.
 * The six-hourly interval scan keeps running beside it.
 *
 * THE CLAIM. Same as the Fleet Monitor morning send (monitor/morning-report.ts):
 * a row in `digest_runs` keyed (kind, digest_date, slot) — kind is a plain
 * varchar and the unique index is partial on slot IN ('morning','evening'), so
 * kind='drive_sales_0830' fits with NO MIGRATION. Several processes (or a box
 * that restarts at 08:31) can only split the work, never scan twice.
 *
 * "A sales scan is already running" counts as a failed attempt, so the next
 * 5-minute tick tries again once that scan is done — files that landed after
 * it listed the folder are still picked up before 09:00.
 */
import { sql } from "drizzle-orm";

import { istSlotState, type Slot } from "@/lib/monitor/schedule";

const KIND = "drive_sales_0830";
const SLOT_NAME = "morning";
/** 5-minute ticks: six attempts cover 08:30–09:00. */
const MAX_ATTEMPTS = 6;
const STUCK_CLAIM_MINUTES = 30;

export const DAILY_SALES_SCAN_SLOT: Slot = { hour: 8, minute: 30 };

/** 08:30 IST by default; DRIVE_SALES_DAILY_AT="8:15" overrides it. */
export function dailySalesScanSlot(): Slot {
  const raw = process.env.DRIVE_SALES_DAILY_AT?.trim();
  const m = raw?.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return DAILY_SALES_SCAN_SLOT;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour > 23 || minute > 59 ? DAILY_SALES_SCAN_SLOT : { hour, minute };
}

export type DailySalesScanOutcome =
  | { ran: false; reason: "not_due" | "already_claimed" }
  | { ran: true; istDate: string; status: "success" | "failed" | "skipped"; detail: string };

async function claim(istDate: string, triggeredBy: string): Promise<number | null> {
  const { db } = await import("@/lib/db");
  try {
    const rows = (await db.execute(sql`
      INSERT INTO digest_runs
          (kind, digest_date, slot, status, attempts, triggered_by, recipients, claimed_at)
      VALUES
          (${KIND}, ${istDate}::date, ${SLOT_NAME}, 'sending', 1, ${triggeredBy}, 'drive', now())
      ON CONFLICT (kind, digest_date, slot) WHERE slot IN ('morning', 'evening')
      DO UPDATE SET
          status       = 'sending',
          attempts     = digest_runs.attempts + 1,
          claimed_at   = now(),
          triggered_by = EXCLUDED.triggered_by
      WHERE
          (digest_runs.status = 'failed' AND digest_runs.attempts < ${MAX_ATTEMPTS})
          OR (digest_runs.status = 'sending'
              AND digest_runs.claimed_at < now() - make_interval(mins => ${STUCK_CLAIM_MINUTES}))
      RETURNING id
    `)) as unknown as Array<{ id: number }>;
    return rows?.[0]?.id ?? null;
  } catch (err) {
    console.error("[drive-sales:daily] claim failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function finish(id: number, status: "sent" | "failed", error: string | null, counts: object) {
  const { db } = await import("@/lib/db");
  try {
    await db.execute(sql`
      UPDATE digest_runs
         SET status = ${status}, error = ${error}, counts = ${JSON.stringify(counts)}::jsonb
       WHERE id = ${id}
    `);
  } catch (err) {
    console.error("[drive-sales:daily] could not record outcome:", err instanceof Error ? err.message : err);
  }
}

/** One claimed scan per IST day from the daily slot onwards; a no-op otherwise. */
export async function runDailySalesScan(opts: {
  now?: Date;
  maxFiles?: number;
  triggeredBy?: "ticker" | "cron" | "manual";
}): Promise<DailySalesScanOutcome> {
  const now = opts.now ?? new Date();
  const state = istSlotState(now, dailySalesScanSlot());
  if (!state.due) return { ran: false, reason: "not_due" };

  const runId = await claim(state.istDate, opts.triggeredBy ?? "ticker");
  if (runId === null) return { ran: false, reason: "already_claimed" };

  try {
    const { runSalesScan } = await import("@/lib/sales/driveSalesScan");
    const r = await runSalesScan({ triggeredBy: null, maxFiles: opts.maxFiles });
    const counts = {
      files_seen: r.files_seen,
      files_new: r.files_new,
      imported: r.imported,
      needs_attention: r.needs_attention,
      failed: r.failed,
    };
    // Another scan holding the guard: retry on the next tick (see header).
    const busy = r.status === "skipped" && /already running/i.test(r.skipped_reason ?? "");
    const failed = r.status === "failed" || busy;
    const detail = r.error ?? r.skipped_reason ?? `imported ${r.imported} of ${r.files_new} new`;
    await finish(runId, failed ? "failed" : "sent", failed ? detail : null, counts);
    return { ran: true, istDate: state.istDate, status: r.status, detail };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await finish(runId, "failed", error, {});
    return { ran: true, istDate: state.istDate, status: "failed", detail: error };
  }
}
