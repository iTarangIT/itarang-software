// ID 227 — Ops Console > Jobs: every scheduled job with its last run.
//
// Joins the static list (scheduledJobs.ts) to scheduled_job_state (E-372,
// written by each tick) and, for once-a-day jobs, the day's claimed run in
// digest_runs. Works before E-372 is applied: the ticks just show "never" and
// the page says the database change is pending.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { istSlotState } from "@/lib/monitor/schedule";
import {
  SCHEDULED_JOBS,
  jobHealth,
  scheduleText,
  type JobHealth,
  type ScheduledJob,
} from "@/lib/operations/scheduledJobs";

export type ScheduledJobStatus = {
  id: string;
  title: string;
  what: string;
  cronPaths: string[];
  runnerKind: ScheduledJob["runner"]["kind"];
  schedule: string;
  jobName: string | null;
  offSwitch: string | null;
  /** Off: why, and who decides. Covered: by which job. */
  note: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastFailedAt: string | null;
  runCount: number | null;
  /** Once-a-day jobs: the IST date and outcome of the last claimed day. */
  dailyDate: string | null;
  dailyStatus: string | null;
  dailyCounts: unknown;
  health: JobHealth;
};

export type ScheduledJobsReport = {
  stateTable: boolean;
  jobs: ScheduledJobStatus[];
  generatedAt: string;
};

type StateRow = {
  name: string;
  last_started_at: string | Date | null;
  last_finished_at: string | Date | null;
  last_status: string | null;
  last_error: string | null;
  last_failed_at: string | Date | null;
  run_count: string | number | null;
};

type DailyRow = { kind: string; digest_date: string | Date; status: string | null; counts: unknown };

const iso = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString() : null);
const ymd = (v: string | Date) => (typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10));

/** "09:30 IST" → { hour: 9, minute: 30 }. */
function parseDailyAt(text: string | undefined): { hour: number; minute: number } | null {
  const m = text?.match(/^(\d{1,2}):(\d{2})/);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

export async function getScheduledJobsReport(now: Date = new Date()): Promise<ScheduledJobsReport> {
  const probe = (await db.execute(sql`
    SELECT to_regclass('public.scheduled_job_state') IS NOT NULL AS ok
  `)) as unknown as Array<{ ok: boolean }>;
  const stateTable = Boolean(probe[0]?.ok);

  const state = new Map<string, StateRow>();
  if (stateTable) {
    const rows = (await db.execute(sql`
      SELECT name, last_started_at, last_finished_at, last_status, last_error, last_failed_at, run_count
        FROM scheduled_job_state
    `)) as unknown as StateRow[];
    for (const r of rows) state.set(r.name, r);
  }

  const dailyKinds = SCHEDULED_JOBS.flatMap((j) =>
    j.runner.kind === "ticker" && j.runner.dailyKind ? [j.runner.dailyKind] : [],
  );
  const daily = new Map<string, DailyRow>();
  if (dailyKinds.length > 0) {
    const rows = (await db.execute(sql`
      SELECT DISTINCT ON (kind) kind, digest_date, status, counts
        FROM digest_runs
       WHERE kind IN (${sql.join(dailyKinds.map((k) => sql`${k}`), sql`, `)})
         AND slot = 'morning'
       ORDER BY kind, digest_date DESC
    `)) as unknown as DailyRow[];
    for (const r of rows) daily.set(r.kind, r);
  }

  const jobs = SCHEDULED_JOBS.map((j): ScheduledJobStatus => {
    const r = j.runner;
    const s = r.kind === "ticker" ? state.get(r.job) : undefined;
    const d = r.kind === "ticker" && r.dailyKind ? daily.get(r.dailyKind) : undefined;
    const slot = r.kind === "ticker" ? parseDailyAt(r.dailyAt) : null;
    const slotState = slot ? istSlotState(now, slot) : null;
    const dailyDate = d ? ymd(d.digest_date) : null;
    const health = jobHealth(
      r,
      s ? { finishedAt: s.last_finished_at ? new Date(s.last_finished_at) : null, status: s.last_status } : null,
      now,
      slotState
        ? { istDate: dailyDate, status: d?.status ?? null, dueToday: slotState.due, todayIst: slotState.istDate }
        : undefined,
    );
    return {
      id: j.id,
      title: j.title,
      what: j.what,
      cronPaths: j.cronPaths,
      runnerKind: r.kind,
      schedule: scheduleText(r),
      jobName: r.kind === "ticker" ? r.job : null,
      offSwitch: r.kind === "ticker" ? (r.offSwitch ?? null) : null,
      note: r.kind === "off" ? `${r.reason} Needs: ${r.decision}.` : r.kind === "covered" ? r.note : null,
      lastStartedAt: iso(s?.last_started_at),
      lastFinishedAt: iso(s?.last_finished_at),
      lastStatus: s?.last_status ?? null,
      lastError: s?.last_error ?? null,
      lastFailedAt: iso(s?.last_failed_at),
      runCount: s?.run_count == null ? null : Number(s.run_count),
      dailyDate,
      dailyStatus: d?.status ?? null,
      dailyCounts: d?.counts ?? null,
      // Before E-372 nothing is recorded: say pending, not "never ran".
      health: !stateTable && health === "never" ? "pending" : health,
    };
  });

  return { stateTable, jobs, generatedAt: now.toISOString() };
}
