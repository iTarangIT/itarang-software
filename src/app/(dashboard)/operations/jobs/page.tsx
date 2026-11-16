import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import UrlSortTh from "@/components/shared/UrlSortTh";
import { makeComparator, sortRows, type SortSpec } from "@/components/shared/tableSortCore";
import {
  formatCount,
  formatDuration,
  formatIst,
  formatMinutesAgo,
  minutesSince,
} from "@/lib/operations/format";
import {
  getCollectorHealth,
  getMonitorFreshness,
  type CollectorHealth,
} from "@/lib/operations/runner";

import {
  getScheduledJobsReport,
  type ScheduledJobsReport,
} from "@/lib/operations/scheduledJobsStatus";

import { AutoRefresh } from "../_components/AutoRefresh";
import { RunCollectorButton } from "../_components/RunCollectorButton";
import { ScheduledJobsCard } from "../_components/ScheduledJobsCard";

export const metadata = { title: "Jobs · Ops Console" };

/** ID 227 — the scheduled jobs list; its own failure never hides the collectors. */
async function ScheduledJobsSection({ sort }: { sort?: { key?: string; dir?: string } }) {
  let report: ScheduledJobsReport;
  try {
    report = await getScheduledJobsReport();
  } catch (e) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-danger">Scheduled jobs unavailable</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-ink-muted">
          {e instanceof Error ? e.message : String(e)}
        </CardContent>
      </Card>
    );
  }
  return <ScheduledJobsCard report={report} sort={sort} />;
}

/**
 * Collector health — "is the monitoring itself alive?"
 *
 * Without this page a silently-dead collector reads as "everything is green",
 * which is the exact failure this console exists to prevent. It is therefore
 * the first module built, and it is the one that must keep rendering when the
 * rest of the console cannot.
 *
 * Reads getCollectorHealth() directly rather than fetching /api/operations/jobs:
 * a server component calling its own HTTP API goes out through nginx and back,
 * so an nginx problem would make the monitoring page fail to explain the
 * problem. The route exists for the client button and for curl.
 */

// ID 243 — header sort on the collectors, kept in the link as ?col_sort=&col_dir=.
// Status orders worst first: failed, stale, running, never run, OK.
const collectorRank = (r: CollectorHealth) =>
  r.status === "failed" ? 0 : r.is_stale ? 1 : r.in_flight ? 2 : !r.status ? 3 : 4;
const COLLECTOR_SORT: SortSpec<CollectorHealth>[] = [
  { key: "collector", type: "text", value: (r) => r.label },
  { key: "status", type: "number", value: collectorRank },
  { key: "last", type: "date", value: (r) => r.last_run_at },
  { key: "every", type: "number", value: (r) => r.interval_ms },
  { key: "duration", type: "number", value: (r) => r.duration_ms },
  { key: "samples", type: "number", value: (r) => r.samples_written },
];

type JobsSearch = { col_sort?: string; col_dir?: string; sched_sort?: string; sched_dir?: string };

function StatusBadge({ row }: { row: CollectorHealth }) {
  if (row.in_flight) return <Badge variant="info">Running</Badge>;
  if (!row.status) return <Badge variant="muted">Never run</Badge>;
  if (row.status === "failed") return <Badge variant="danger">Failed</Badge>;
  // Completed, but not recently enough — the numbers it feeds are stale even
  // though its last run was a success.
  if (row.is_stale) return <Badge variant="warning">Stale</Badge>;
  return <Badge variant="success">OK</Badge>;
}

function MissingTables({ message }: { message: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base text-danger">
          Collector tables unavailable
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-ink-muted">
        <p>
          The console could not read <code>ops_collector_runs</code>. If the
          error below says a relation does not exist, this database has not had{" "}
          <code>drizzle/E-210_ops_monitoring.sql</code> applied — migrations do
          not auto-run here.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-bg p-3 text-[11px] text-ink">
          {message}
        </pre>
        <p>
          Apply the file by hand (Supabase SQL editor / pgAdmin) and tick the
          row in <code>drizzle/MIGRATION_CHECKLIST.md</code>. Re-running it is a
          no-op.
        </p>
      </CardContent>
    </Card>
  );
}

export default async function OperationsJobsPage({ searchParams }: { searchParams: Promise<JobsSearch> }) {
  const sp = await searchParams;
  const schedSort = { key: sp.sched_sort, dir: sp.sched_dir };
  let rows: CollectorHealth[];
  let freshness: Awaited<ReturnType<typeof getMonitorFreshness>>;

  try {
    [rows, freshness] = await Promise.all([
      getCollectorHealth(),
      getMonitorFreshness(),
    ]);
  } catch (e) {
    return (
      <div className="space-y-4">
        <ScheduledJobsSection sort={schedSort} />
        <MissingTables
          message={e instanceof Error ? e.message : String(e)}
        />
      </div>
    );
  }

  const colSpec = COLLECTOR_SORT.find((s) => s.key === sp.col_sort);
  if (colSpec) rows = sortRows(rows, makeComparator(colSpec, sp.col_dir === "desc" ? "desc" : "asc"));

  const failing = rows.filter((r) => r.status === "failed").length;
  const stale = rows.filter((r) => r.is_stale && r.status !== "failed").length;

  return (
    <div className="space-y-4">
      <ScheduledJobsSection sort={schedSort} />
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Collector Health</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Every registered collector and its most recent run. A collector
              that stops producing rows here is why a green board can be lying.
            </p>
          </div>
          <AutoRefresh intervalMs={15_000} />
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <Badge variant={failing > 0 ? "danger" : "muted"}>
              {failing} failing
            </Badge>
            <Badge variant={stale > 0 ? "warning" : "muted"}>{stale} stale</Badge>
            <Badge variant="muted">{rows.length} registered</Badge>
            <span className="ml-auto tabular-nums">
              Last successful run: {formatMinutesAgo(freshness.minutes_ago)}
            </span>
          </div>

          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-muted">
              No collectors are registered. Add one to{" "}
              <code>src/lib/operations/collectors/index.ts</code>.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    <UrlSortTh label="Collector" sortKey="collector" type="text" prefix="col_" className="py-2 pl-0 pr-3" />
                    <UrlSortTh label="Status" sortKey="status" type="number" prefix="col_" className="py-2 pl-0 pr-3" />
                    <UrlSortTh label="Last run" sortKey="last" type="date" prefix="col_" className="py-2 pl-0 pr-3" />
                    <UrlSortTh label="Every" sortKey="every" type="number" prefix="col_" className="py-2 pl-0 pr-3" align="right" />
                    <UrlSortTh label="Duration" sortKey="duration" type="number" prefix="col_" className="py-2 pl-0 pr-3" align="right" />
                    <UrlSortTh label="Samples" sortKey="samples" type="number" prefix="col_" className="py-2 pl-0 pr-3" align="right" />
                    <th className="py-2 pl-3 text-right">Run</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const ageMin = minutesSince(row.last_run_at);
                    return (
                      <tr
                        key={row.collector_id}
                        className="border-b border-border/60 align-top last:border-0"
                      >
                        <td className="py-2.5 pr-3">
                          <div className="font-medium text-ink">{row.label}</div>
                          <div className="font-mono text-[11px] text-ink-muted">
                            {row.collector_id}
                          </div>
                          {row.error && (
                            <div
                              className="mt-1 max-w-[28rem] truncate text-[11px] text-danger"
                              title={row.error}
                            >
                              {row.error}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 pr-3">
                          <StatusBadge row={row} />
                        </td>
                        <td className="py-2.5 pr-3 text-xs text-ink-muted">
                          {row.last_run_at ? (
                            <>
                              <div className="tabular-nums">
                                {formatMinutesAgo(ageMin)}
                              </div>
                              <div className="text-[11px]">
                                {formatIst(row.last_run_at)}
                              </div>
                            </>
                          ) : (
                            "never"
                          )}
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums text-xs text-ink-muted">
                          {formatDuration(row.interval_ms / 1000)}
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums text-xs text-ink-muted">
                          {row.duration_ms == null
                            ? "—"
                            : `${formatCount(row.duration_ms)} ms`}
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums text-xs text-ink-muted">
                          {row.samples_written == null
                            ? "—"
                            : formatCount(row.samples_written)}
                        </td>
                        <td className="py-2.5 pl-3">
                          <RunCollectorButton
                            collectorId={row.collector_id}
                            inFlight={row.in_flight}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
