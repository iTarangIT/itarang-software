import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCount, formatIst } from "@/lib/operations/format";
import {
  getLogsView,
  MAX_LINES,
  parseFilters,
  type ErrorGroup,
  type LogFilters,
} from "@/lib/operations/logs";

import { AutoRefresh } from "../_components/AutoRefresh";
import { LogFilterBar } from "../_components/LogFilterBar";
import { LogRateChart } from "../_components/LogRateChart";

export const metadata = { title: "Logs · Ops Console" };

/**
 * Log explorer over ops_log_events.
 *
 * The grouped table comes first and the raw lines second, deliberately. One
 * error repeated 10,000 times is one problem; ten distinct new ones are ten,
 * and a page that leads with raw lines makes the loud problem look like the
 * only problem. Grouping is by fingerprint — see src/lib/operations/fingerprint.ts.
 *
 * Lines arrive by push: ops-agent tails the pm2 and nginx files on each box and
 * forwards new lines every 5 minutes, tracking a byte offset so each line is
 * sent exactly once.
 */

function levelBadge(level: string) {
  if (level === "error") return <Badge variant="danger">error</Badge>;
  if (level === "warn") return <Badge variant="warning">warn</Badge>;
  return <Badge variant="muted">{level}</Badge>;
}

/** Preserve the active filters when linking to a drill-down or the export. */
function queryFor(filters: LogFilters, overrides: Record<string, string> = {}) {
  const params = new URLSearchParams();
  if (filters.host) params.set("host", filters.host);
  if (filters.service) params.set("service", filters.service);
  if (filters.level) params.set("level", filters.level);
  if (filters.q) params.set("q", filters.q);
  if (filters.fingerprint) params.set("fingerprint", filters.fingerprint);
  params.set("hours", String(filters.hours));
  for (const [key, value] of Object.entries(overrides)) params.set(key, value);
  return params.toString();
}

function GroupRow({
  group,
  filters,
}: {
  group: ErrorGroup;
  filters: LogFilters;
}) {
  const active = filters.fingerprint === group.fingerprint;

  return (
    <tr
      className={`border-b border-border/60 align-top last:border-0 ${
        active ? "bg-brand-50/60" : ""
      }`}
    >
      <td className="py-2.5 pr-3 text-right tabular-nums font-semibold text-ink">
        {formatCount(group.count)}
      </td>
      <td className="py-2.5 pr-3">{levelBadge(group.level)}</td>
      <td className="py-2.5 pr-3">
        <div className="max-w-[42rem] truncate text-[12px] text-ink" title={group.sample}>
          {group.sample}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
          <span className="font-mono">{group.service}</span>
          {group.hosts.map((host) => (
            <span key={host} className="rounded bg-bg px-1.5">
              {host}
            </span>
          ))}
          <span>first {formatIst(group.first_at)}</span>
          <span>last {formatIst(group.last_at)}</span>
        </div>
      </td>
      <td className="py-2.5 pl-3 text-right">
        <Link
          href={
            active
              ? `/operations/logs?${queryFor({ ...filters, fingerprint: undefined })}`
              : `/operations/logs?${queryFor(filters, { fingerprint: group.fingerprint })}`
          }
          className="whitespace-nowrap rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-ink-muted hover:bg-brand-50"
        >
          {active ? "Clear" : "View lines"}
        </Link>
      </td>
    </tr>
  );
}

export default async function OperationsLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseFilters(await searchParams);

  let view: Awaited<ReturnType<typeof getLogsView>>;
  try {
    view = await getLogsView(filters);
  } catch (e) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-danger">
            Log events unavailable
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-ink-muted">
          <pre className="overflow-x-auto rounded-lg bg-bg p-3 text-[11px] text-ink">
            {e instanceof Error ? e.message : String(e)}
          </pre>
          <p>
            If this says a relation does not exist, apply{" "}
            <code>drizzle/E-210_ops_monitoring.sql</code> to this database.
          </p>
        </CardContent>
      </Card>
    );
  }

  const empty =
    view.totals.errors + view.totals.warns + view.totals.infos === 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Logs</CardTitle>
              <p className="mt-1 text-xs text-ink-muted">
                Forwarded by <code>ops-agent</code> from the pm2 and nginx files
                on each box, every 5 minutes. Retained 14 days.
              </p>
            </div>
            <AutoRefresh intervalMs={30_000} />
          </div>
          <LogFilterBar
            filters={filters}
            facets={view.facets}
            exportHref={`/api/operations/logs/export.xlsx?${queryFor(filters)}`}
          />
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={view.totals.errors > 0 ? "danger" : "muted"}>
              {formatCount(view.totals.errors)} errors
            </Badge>
            <Badge variant={view.totals.warns > 0 ? "warning" : "muted"}>
              {formatCount(view.totals.warns)} warnings
            </Badge>
            <Badge variant="muted">{formatCount(view.totals.infos)} info</Badge>
            <Badge variant="muted">
              {formatCount(view.groups.length)} distinct
            </Badge>
          </div>
          <LogRateChart points={view.rate} />
        </CardContent>
      </Card>

      {empty ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Nothing in this window</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-ink-muted">
            <p>
              No log lines match these filters. If no host has ever reported,
              the agent is not forwarding yet — log tailing needs{" "}
              <code>OPS_LOG_FILES</code> to point at files it can read, and it
              only forwards <code>warn</code> and above by default (
              <code>OPS_LOG_MIN_LEVEL</code>).
            </p>
            <p>
              See <code>ops-agent/README.md</code>, and{" "}
              <Link href="/operations/jobs" className="underline">
                /operations/jobs
              </Link>{" "}
              to confirm the collectors are running at all.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top errors</CardTitle>
              <p className="mt-1 text-xs text-ink-muted">
                Grouped by fingerprint — the message with ids, numbers and
                timestamps normalised out, so the same error at different values
                counts once.
              </p>
            </CardHeader>
            <CardContent>
              {view.groups.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  No groups for these filters.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[44rem] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                        <th className="py-2 pr-3 text-right">Count</th>
                        <th className="py-2 pr-3">Level</th>
                        <th className="py-2 pr-3">Sample message</th>
                        <th className="py-2 pl-3" />
                      </tr>
                    </thead>
                    <tbody>
                      {view.groups.map((group) => (
                        <GroupRow
                          key={group.fingerprint}
                          group={group}
                          filters={filters}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">
                  {filters.fingerprint ? "Lines in this group" : "Recent lines"}
                </CardTitle>
                <p className="mt-1 text-xs text-ink-muted">
                  Newest first.
                  {view.truncated &&
                    ` Showing the newest ${MAX_LINES} — narrow the window or the filters, or export.`}
                </p>
              </div>
              {view.truncated && <Badge variant="warning">Truncated</Badge>}
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      <th className="py-2 pr-3">Time</th>
                      <th className="py-2 pr-3">Level</th>
                      <th className="py-2 pr-3">Host</th>
                      <th className="py-2 pr-3">Service</th>
                      <th className="py-2">Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.lines.map((line) => (
                      <tr
                        key={line.id}
                        className="border-b border-border/60 align-top last:border-0"
                      >
                        <td className="whitespace-nowrap py-2 pr-3 text-[11px] tabular-nums text-ink-muted">
                          {formatIst(line.logged_at, { withSeconds: true })}
                        </td>
                        <td className="py-2 pr-3">{levelBadge(line.level)}</td>
                        <td className="py-2 pr-3 text-[11px] text-ink-muted">
                          {line.host}
                        </td>
                        <td className="py-2 pr-3 font-mono text-[11px] text-ink-muted">
                          {line.service}
                        </td>
                        <td className="py-2 font-mono text-[11px] text-ink">
                          <div className="max-w-[52rem] whitespace-pre-wrap break-words">
                            {line.message}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
