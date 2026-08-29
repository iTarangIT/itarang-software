/**
 * The collector contract.
 *
 * A collector is a PURE async function: it reads (a table, an HTTP endpoint,
 * pg_stat_*) and returns samples. It performs no writes and knows nothing about
 * scheduling, locking or alerting — the runner owns all of that. Keeping the
 * two apart is what makes "add a monitor" a one-file change, and it is why a
 * collector can be unit-tested without a database.
 */

export interface CollectedSample {
  /** Must match a MetricDef.key in ../registry.ts. */
  metric_key: string;
  /**
   * Which instance of the thing this measures: "host:prod", "rds:crm",
   * "vendor:elevenlabs", "job:zoho_sync". One metric_key with several sources
   * is the normal case — that is how one MetricDef covers three hosts.
   */
  source: string;
  value_num?: number | null;
  value_text?: string | null;
  meta?: Record<string, unknown>;
  /** Defaults to now() at write time. Set it when back-dating ingested data. */
  captured_at?: Date;
}

export interface OpsCollector {
  /** Stable id, e.g. "db.rds.crm". Written to ops_collector_runs.collector_id. */
  id: string;
  label: string;
  /** How often this collector is due. The runner ticks every 60s and skips collectors that ran recently. */
  intervalMs: number;
  /** Hard cap on a single run. Default 10s — see runner.ts. */
  timeoutMs?: number;
  run(): Promise<CollectedSample[]>;
}

/** Seconds/minutes as milliseconds, so interval declarations read as prose. */
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
