// E-228 + E-254 — the AI dialer calling window: the SERVER half.
//
// The SQL predicates (is the window open? when does it next open?), the pause
// writer, and the assignment_config defaults lookup. Everything here needs the
// database; the vocabulary, zod schema and formatters live in
// ./campaignSchedule so client components and vitest can use them without
// pulling Drizzle in. This file re-exports them, so server code has one import.
//
// THE CLOCK IS THE DATABASE'S. Every time comparison happens in SQL against
// now(), never against a JS Date — the rule src/lib/scraper/jobQueue.ts records
// after clock skew between the pm2 VPS and RDS made auction lots close minutes
// late. It also means the web process, the in-process ticker and any cron
// cannot disagree about whether a window is open, which matters because all
// three can reach advanceCampaign for the same campaign in the same second.
//
// The predicates below are deliberate ports of the ELIGIBLE expression in
// src/lib/scraper/jobQueue.ts:125-150. E-241 wrote that against E-228's exact
// 'HH:MM' + ["mon",…] vocabulary specifically so one reader could serve both;
// this is that reader.

import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { dialerCampaigns } from "@/lib/db/schema";
import {
  FALLBACK_DEFAULTS,
  WEEKDAYS,
  toHHMM,
  type ScheduleMode,
  type Weekday,
} from "./campaignSchedule";

export * from "./campaignSchedule";

const IST = "Asia/Kolkata";

// ── the SQL predicates ─────────────────────────────────────────────────────

// Is the window open right now?
//
// 'now', or any row missing either bound, is ALWAYS open — that is the E-228
// backward-compatibility guarantee (NULL = unscheduled) and it is checked
// before anything reads the bounds.
//
// The CASE is the overnight window (e.g. 22:00-06:00). When window_end is the
// smaller string the window wraps midnight, so membership is "at or after the
// start OR before the end" rather than BETWEEN. Storing two plain HH:MM strings
// keeps that decision in this one predicate instead of in the data.
//
// `nowExpr` exists so scripts/verify-e254-campaign-window.mjs can evaluate the
// predicate at a synthetic instant instead of waiting for a real 11am. Nothing
// in the application passes it.
export function windowOpenSql(nowExpr: SQL = sql`now()`): SQL<boolean> {
  return sql<boolean>`(
    schedule_mode = 'now'
    OR schedule_mode IS NULL
    OR window_start IS NULL
    OR window_end IS NULL
    OR (
      (
        window_days IS NULL
        OR window_days @> to_jsonb(
             lower(to_char(${nowExpr} AT TIME ZONE ${IST}, 'dy'))
           )
      )
      AND CASE
            WHEN window_end > window_start
              THEN to_char(${nowExpr} AT TIME ZONE ${IST}, 'HH24:MI') >= window_start
               AND to_char(${nowExpr} AT TIME ZONE ${IST}, 'HH24:MI') <  window_end
            ELSE to_char(${nowExpr} AT TIME ZONE ${IST}, 'HH24:MI') >= window_start
              OR to_char(${nowExpr} AT TIME ZONE ${IST}, 'HH24:MI') <  window_end
          END
    )
  )`;
}

// The next instant this campaign's window opens, as a timestamptz.
//
// Walks the next 8 IST calendar days and takes the earliest listed day whose
// start time is strictly in the future. Eight days rather than two because
// window_days may name a single weekday — a Monday-only campaign pausing on
// Monday evening must resume next Monday, not tomorrow.
//
// Strictly `> nowExpr` is load-bearing: without it a campaign closing at 15:00,
// whose window opened at 11:00 today, would resolve today's 11:00 — already
// past — and the resume ticker would wake it instantly into a shut window, a
// tight pause/resume loop that would burn a tick every 60 seconds forever.
//
// NULL when the row is unscheduled or names no reachable day. Callers treat a
// NULL as "nothing to arm" and fall back to the manual-resume state.
//
// The day series is generate_series(0, 7) over INTEGERS added to a date, and not
// generate_series(date, date, interval). That looks like the obvious spelling
// and is wrong: Postgres resolves the (date, date, interval) form to the
// TIMESTAMPTZ overload, so each element arrives as a timestamptz at UTC
// midnight — and `AT TIME ZONE` applied to a timestamptz runs in the INVERSE
// direction, converting to local time rather than from it. An 11:00 window
// resolved to 16:30 and every candidate looked like it was in the future, so
// the predicate always returned today. `date + int` stays a date, `date + time`
// is a plain timestamp, and AT TIME ZONE then means what it reads as.
export function nextWindowOpenSql(nowExpr: SQL = sql`now()`): SQL<Date | null> {
  return sql<Date | null>`(
    CASE
      WHEN window_start IS NULL OR schedule_mode = 'now' OR schedule_mode IS NULL
        THEN NULL
      ELSE (
        SELECT min((g.day + window_start::time) AT TIME ZONE ${IST})
          FROM generate_series(0, 7) AS n
          CROSS JOIN LATERAL (
            SELECT ((${nowExpr} AT TIME ZONE ${IST})::date + n) AS day
          ) AS g
         WHERE (
                 window_days IS NULL
                 OR window_days @> to_jsonb(lower(to_char(g.day, 'dy')))
               )
           AND (g.day + window_start::time) AT TIME ZONE ${IST} > ${nowExpr}
      )
    END
  )`;
}

// ── the pause writer ───────────────────────────────────────────────────────

export type WindowPauseOutcome = {
  status: "scheduled" | "paused";
  resumeAt: Date | null;
};

/**
 * Park a running campaign because its window is shut.
 *
 * Deliberately NOT finalizeCampaign(): that function unconditionally stamps
 * completed_at, so routing a pause through it would make a campaign that is
 * merely waiting for 11am read as finished everywhere — the campaign card, the
 * reports, and the resume gate.
 *
 * `AND status = 'running'` makes this idempotent and race-safe: the webhook
 * chain, the 30s poll and the 2m watchdog can all reach advanceCampaign for the
 * same campaign at once, and only the first pause lands. The others update 0
 * rows and return the state the first one wrote.
 */
export async function pauseForWindow(
  campaignId: string,
  mode: ScheduleMode,
  nextOpenAt: Date | null,
): Promise<WindowPauseOutcome> {
  // A recurring campaign with no reachable next opening has nothing to arm, so
  // it falls back to the manual state rather than sitting in 'scheduled' with a
  // NULL resume_after that no ticker will ever claim.
  const auto = mode === "recurring" && nextOpenAt != null;
  const status = auto ? "scheduled" : "paused";

  await db
    .update(dialerCampaigns)
    .set({
      status,
      paused_at: new Date(),
      resume_after: auto ? nextOpenAt : null,
    })
    .where(
      and(
        eq(dialerCampaigns.id, campaignId),
        eq(dialerCampaigns.status, "running"),
      ),
    );

  return { status, resumeAt: auto ? nextOpenAt : null };
}

/**
 * The window the campaign form pre-fills with, from assignment_config (E-120).
 *
 * E-120 shipped working_hours_start / working_hours_end / working_days with a
 * validated admin API and UI, and then nothing ever read them — only
 * intent_score_threshold is consumed (by finalizeCall). This is their first
 * real consumer.
 *
 * Note the width mismatch: assignment_config stores varchar(8) while the
 * campaign window columns are varchar(5), so a stored '09:00:00' has to be
 * truncated to 'HH:MM' or it fails the HHMM regex on the way back in.
 */
export async function resolveScheduleDefaults(): Promise<
  typeof FALLBACK_DEFAULTS
> {
  try {
    const rows = await db.execute<{
      working_hours_start: string | null;
      working_hours_end: string | null;
      working_days: unknown;
    }>(sql`
      SELECT working_hours_start, working_hours_end, working_days
        FROM assignment_config
       ORDER BY created_at ASC
       LIMIT 1
    `);
    const r = (rows as unknown as Array<Record<string, unknown>>)[0];
    if (!r) return FALLBACK_DEFAULTS;

    const days = Array.isArray(r.working_days)
      ? (r.working_days as string[]).filter((d): d is Weekday =>
          (WEEKDAYS as readonly string[]).includes(d),
        )
      : [];

    return {
      window_start:
        toHHMM(r.working_hours_start) ?? FALLBACK_DEFAULTS.window_start,
      window_end: toHHMM(r.working_hours_end) ?? FALLBACK_DEFAULTS.window_end,
      window_days: days.length ? days : FALLBACK_DEFAULTS.window_days,
    };
  } catch (err) {
    // A missing assignment_config row is not worth failing a campaign form
    // over — the fallbacks are the same 09:00-19:00 Mon-Sat the table itself
    // defaults to.
    console.error("[campaignWindow] resolveScheduleDefaults failed:", err);
    return FALLBACK_DEFAULTS;
  }
}
