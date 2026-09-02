import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatDuration,
  formatMs,
  formatPercent,
  formatMinutesAgo,
} from "@/lib/operations/format";
import { getSystemView } from "@/lib/operations/system";

import { AutoRefresh } from "../_components/AutoRefresh";
import { MetricSparkline } from "../_components/MetricSparkline";

export const metadata = { title: "System · Ops Console" };

/**
 * The application's own vital signs: dependency health, the Upstash quota
 * circuit, background-job liveness and which build each environment is on.
 *
 * Reads only ops_metric_samples — the page that tells you whether the app is
 * healthy must not itself depend on the app being healthy. Nothing here probes
 * a dependency live; the app-health collector already did that in-process, so
 * these numbers agree with /api/health by construction rather than by a second
 * opinion taken a moment later.
 */

export default async function OperationsSystemPage() {
  let view: Awaited<ReturnType<typeof getSystemView>>;
  try {
    view = await getSystemView();
  } catch (e) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-danger">System view unavailable</CardTitle>
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

  const downJobs = view.jobs.filter((j) => j.failed || j.age_severity === "crit");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {view.deploys.map((d) => (
          <Badge
            key={d.source}
            variant={view.deploy_mismatch ? "warning" : "outline"}
            title={`${d.source} — up ${formatDuration(d.uptime_s)}${d.pid ? `, pid ${d.pid}` : ""}`}
          >
            {d.source.replace(/^app:/, "")} @ {d.commit}
            {d.node_env ? ` (${d.node_env})` : ""}
          </Badge>
        ))}
        {view.deploy_mismatch && (
          <Badge variant="warning">Environments on different builds</Badge>
        )}
        {view.redis && (
          <Badge variant={view.redis.circuit_open ? "danger" : "muted"}>
            Upstash circuit {view.redis.circuit_open ? "OPEN" : "closed"}
            {view.redis.worker_enabled === false && " · worker off"}
          </Badge>
        )}
        <div className="ml-auto">
          <AutoRefresh intervalMs={30_000} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dependencies</CardTitle>
          <p className="mt-1 text-xs text-ink-muted">
            The same probes <code>/api/health</code> runs, against the same
            clients — so these agree with the deploy gate by construction. Uptime
            is over the last {view.window_hours} hours.
          </p>
        </CardHeader>
        <CardContent>
          {view.dependencies.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No dependency samples yet — check{" "}
              <Link href="/operations/jobs" className="underline">
                /operations/jobs
              </Link>
              .
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    <th className="py-2 pr-3">Dependency</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3 text-right">Latency</th>
                    <th className="py-2 pr-3 text-right">Uptime {view.window_hours}h</th>
                    <th className="py-2">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {view.dependencies.map((dep) => (
                    <tr
                      key={dep.name}
                      className="border-b border-border/60 align-top last:border-0"
                    >
                      <td className="py-2.5 pr-3 font-medium text-ink">{dep.name}</td>
                      <td className="py-2.5 pr-3">
                        {dep.ok === null ? (
                          <Badge variant="muted">unknown</Badge>
                        ) : dep.ok ? (
                          <Badge variant="success">up</Badge>
                        ) : (
                          <Badge variant="danger">down</Badge>
                        )}
                        {dep.detail && (
                          <div
                            className="mt-1 max-w-[18rem] truncate text-[11px] text-danger"
                            title={dep.detail}
                          >
                            {dep.detail}
                          </div>
                        )}
                      </td>
                      <td
                        className={`py-2.5 pr-3 text-right tabular-nums ${
                          dep.latency_severity === "crit"
                            ? "text-danger"
                            : dep.latency_severity === "warn"
                              ? "text-warning"
                              : "text-ink-muted"
                        }`}
                      >
                        {formatMs(dep.latency_ms)}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-ink-muted">
                        {dep.uptime_pct == null ? "—" : formatPercent(dep.uptime_pct)}
                        <div className="text-[10px]">{dep.samples} samples</div>
                      </td>
                      <td className="w-40 py-2.5 text-ink-muted">
                        <MetricSparkline points={dep.latency_series} />
                      </td>
                    </tr>
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
            <CardTitle className="text-base">Background job liveness</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              A job that stops running produces no errors, no alerts and no logs.
              It just goes quiet, and quiet reads as healthy — which is why this
              table exists.
            </p>
          </div>
          {downJobs.length > 0 && (
            <Badge variant="danger">{downJobs.length} need attention</Badge>
          )}
        </CardHeader>
        <CardContent>
          {view.jobs.length === 0 ? (
            <p className="text-sm text-ink-muted">No job samples yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[38rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    <th className="py-2 pr-3">Job</th>
                    <th className="py-2 pr-3">Last run</th>
                    <th className="py-2 pr-3">Outcome</th>
                    <th className="py-2">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {view.jobs.map((job) => (
                    <tr
                      key={job.job}
                      className="border-b border-border/60 align-top last:border-0"
                    >
                      <td className="py-2.5 pr-3">
                        <div className="font-medium text-ink">{job.label}</div>
                        <div className="font-mono text-[11px] text-ink-muted">
                          {job.job}
                        </div>
                      </td>
                      <td
                        className={`py-2.5 pr-3 tabular-nums text-xs ${
                          job.age_severity === "crit"
                            ? "text-danger"
                            : job.age_severity === "warn"
                              ? "text-warning"
                              : "text-ink-muted"
                        }`}
                      >
                        {job.age_minutes == null
                          ? "never"
                          : formatMinutesAgo(job.age_minutes)}
                      </td>
                      <td className="py-2.5 pr-3">
                        {job.unavailable ? (
                          <Badge variant="muted">not present</Badge>
                        ) : job.failed === null ? (
                          <Badge variant="muted">unknown</Badge>
                        ) : job.failed ? (
                          <Badge variant="danger">failed</Badge>
                        ) : (
                          <Badge variant="success">ok</Badge>
                        )}
                      </td>
                      <td
                        className="max-w-[26rem] py-2.5 text-[11px] text-ink-muted"
                        title={job.unavailable ?? job.error ?? ""}
                      >
                        <div className="truncate">
                          {job.unavailable ?? job.error ?? ""}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Collector health</CardTitle>
          <p className="mt-1 text-xs text-ink-muted">
            Is the monitoring itself alive? Full detail and a manual re-run live
            on{" "}
            <Link href="/operations/jobs" className="underline">
              /operations/jobs
            </Link>
            .
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {view.collectors.length === 0 ? (
              <span className="text-sm text-ink-muted">No collector runs yet.</span>
            ) : (
              view.collectors.map((c) => (
                <Badge
                  key={c.collector_id}
                  variant={
                    c.status === "failed"
                      ? "danger"
                      : c.is_stale
                        ? "warning"
                        : "success"
                  }
                  title={c.error ?? `${c.samples_written ?? 0} samples`}
                >
                  {c.collector_id}
                </Badge>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
