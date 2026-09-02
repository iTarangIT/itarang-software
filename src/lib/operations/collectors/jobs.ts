/**
 * Background-job liveness.
 *
 * "When did each job last complete, and did it work?" This is the module that
 * would have caught the Zoho sync ticker being dead on prod — a job that stops
 * running produces no errors, no alerts and no logs. It just goes quiet, and
 * quiet reads as healthy.
 *
 * Every job here is read from its own run table with raw SQL and each read is
 * wrapped, because these tables drift between environments: an unapplied
 * migration must cost us one metric, not the whole collector.
 *
 * NOTE on scraper_runs: `scraper_runs` is declared TWICE in schema.ts
 * (`scraperRuns` ~L2548 and `scrapeRuns` ~L3073, same table, divergent column
 * sets). We query it by raw SQL precisely to sidestep the ambiguity — the
 * columns used below exist in both declarations.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import type { CollectedSample, OpsCollector } from "./types";
import { MINUTE } from "./types";

interface JobProbe {
  /** Becomes the sample source, e.g. "job:zoho_sync". */
  id: string;
  label: string;
  /**
   * Must return at most one row shaped { last_at, status }. `status` is
   * normalised below: anything that is not a recognised success is a failure.
   */
  query: ReturnType<typeof sql>;
}

/**
 * A run table's "most recent attempt". COALESCE(finished, started) so a job
 * that is mid-run still reports a recent timestamp rather than looking dead.
 */
const PROBES: JobProbe[] = [
  {
    id: "zoho_sync",
    label: "Zoho invoice sync",
    // Singleton row (id = 1), not a run history — it carries last_run_at,
    // last_status and last_error and nothing else.
    query: sql`
      SELECT last_run_at AS last_at, last_status AS status, last_error AS error
      FROM zoho_sync_state WHERE id = 1 LIMIT 1
    `,
  },
  {
    id: "risk_runs",
    label: "NBFC risk engine",
    query: sql`
      SELECT COALESCE(finished_at, started_at) AS last_at, status, error
      FROM risk_runs ORDER BY started_at DESC LIMIT 1
    `,
  },
  {
    id: "risk_card_runs",
    label: "NBFC risk cards",
    // `run_at`, NOT started_at/finished_at. This table is shaped differently
    // from every other *_runs table — it is one row per card evaluation, not a
    // job lifecycle, so it has no start/finish pair and no status column.
    // Probing it like its neighbours silently produced an "unavailable" sample
    // on every run instead of the liveness number.
    //
    // status stays NULL deliberately. There is no success/failure to report,
    // and the only status-shaped column (verdict_source: 'llm' | 'rule' | …)
    // is not a status — feeding it in would fail the SUCCESS check below and
    // permanently flag a healthy job as failing. A NULL status scores 0.
    query: sql`
      SELECT run_at AS last_at, NULL::text AS status, NULL::text AS error
      FROM risk_card_runs ORDER BY run_at DESC LIMIT 1
    `,
  },
  {
    id: "scraper_runs",
    label: "Lead scraper",
    query: sql`
      SELECT COALESCE(completed_at, started_at) AS last_at, status, error_message AS error
      FROM scraper_runs ORDER BY started_at DESC LIMIT 1
    `,
  },
  {
    id: "ops_collectors",
    label: "Ops collectors",
    // The monitoring watching itself. Without this row, a totally dead runner
    // shows as "no data" on every other tile rather than as one clear failure.
    query: sql`
      SELECT COALESCE(finished_at, started_at) AS last_at, status, error
      FROM ops_collector_runs ORDER BY started_at DESC LIMIT 1
    `,
  },
];

/** Statuses that mean "this run worked", across the various run tables. */
const SUCCESS = new Set(["completed", "success", "succeeded", "ok", "done"]);
/** Statuses that mean "still going" — neither success nor failure yet. */
const IN_FLIGHT = new Set(["running", "in_progress", "pending", "queued"]);

export const jobsCollector: OpsCollector = {
  id: "system.jobs",
  label: "Background job liveness",
  intervalMs: 5 * MINUTE,
  timeoutMs: 20_000,

  async run(): Promise<CollectedSample[]> {
    const samples: CollectedSample[] = [];

    for (const probe of PROBES) {
      let row: { last_at?: unknown; status?: unknown; error?: unknown } | undefined;

      try {
        const rows = (await db.execute(probe.query)) as unknown as Array<
          Record<string, unknown>
        >;
        row = rows?.[0];
      } catch (e) {
        // Almost always "relation does not exist" — an unapplied migration on
        // this environment. Record it as a text sample so /operations/system
        // can say "not present here" rather than silently omitting the job.
        samples.push({
          metric_key: "job.last_run_failed",
          source: `job:${probe.id}`,
          value_num: null,
          value_text: `unavailable: ${
            e instanceof Error ? e.message.slice(0, 200) : String(e)
          }`,
          meta: { label: probe.label, unavailable: true },
        });
        continue;
      }

      const lastAt = row?.last_at ? new Date(row.last_at as string) : null;
      const status = row?.status ? String(row.status).toLowerCase() : null;
      const inFlight = status ? IN_FLIGHT.has(status) : false;

      samples.push({
        metric_key: "job.last_run_age_min",
        source: `job:${probe.id}`,
        // Never run at all → null, not 0. Zero would read as "just ran", which
        // is the opposite of the truth.
        value_num:
          lastAt && !Number.isNaN(lastAt.getTime())
            ? Math.round((Date.now() - lastAt.getTime()) / 60_000)
            : null,
        value_text: status,
        meta: {
          label: probe.label,
          last_at: lastAt?.toISOString() ?? null,
          in_flight: inFlight,
        },
      });

      samples.push({
        metric_key: "job.last_run_failed",
        source: `job:${probe.id}`,
        // A job mid-run has not failed. Only a terminal non-success counts.
        value_num: status == null || inFlight ? 0 : SUCCESS.has(status) ? 0 : 1,
        value_text: row?.error ? String(row.error).slice(0, 500) : null,
        meta: { label: probe.label, status },
      });
    }

    return samples;
  },
};
