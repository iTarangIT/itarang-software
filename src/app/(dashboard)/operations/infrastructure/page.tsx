import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCount, formatDuration, formatMinutesAgo } from "@/lib/operations/format";
import { getInfrastructureView, type HostView } from "@/lib/operations/views";

import { AutoRefresh } from "../_components/AutoRefresh";
import { MetricTile } from "../_components/MetricTile";

export const metadata = { title: "Infrastructure · Ops Console" };

/**
 * Per-host vitals and the pm2 process table.
 *
 * Everything here arrives by PUSH — ops-agent/agent.js on each box POSTs to
 * /api/operations/ingest/host every 5 minutes. The page reads samples; it never
 * reaches out to a box. A host whose agent has stopped therefore shows its last
 * known numbers with an explicit "agent last seen" age, which is the honest
 * rendering: the box may be fine and the agent dead, or the box may be gone.
 */

function AgentBadge({ host }: { host: HostView }) {
  if (host.never_reported) return <Badge variant="danger">Never reported</Badge>;
  if (host.agent_severity === "crit") {
    return (
      <Badge variant="danger">
        Agent silent {formatMinutesAgo(host.agent_age_minutes)}
      </Badge>
    );
  }
  if (host.agent_severity === "warn") {
    return (
      <Badge variant="warning">
        Agent late {formatMinutesAgo(host.agent_age_minutes)}
      </Badge>
    );
  }
  return (
    <Badge variant="success">
      Agent seen {formatMinutesAgo(host.agent_age_minutes)}
    </Badge>
  );
}

function ProcessTable({ host }: { host: HostView }) {
  if (host.processes.length === 0) {
    return (
      <p className="mt-3 text-xs text-ink-muted">
        No pm2 processes reported. The agent runs <code>pm2 jlist</code>; an
        empty list means pm2 is not installed or not running as the agent&apos;s
        user.
      </p>
    );
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            <th className="py-2 pr-3">Process</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3 text-right">Restarts</th>
            <th className="py-2 pr-3 text-right">Memory</th>
            <th className="py-2 pr-3 text-right">CPU</th>
            <th className="py-2 text-right">Uptime</th>
          </tr>
        </thead>
        <tbody>
          {host.processes.map((proc) => (
            <tr key={proc.source} className="border-b border-border/60 last:border-0">
              <td className="py-2 pr-3 font-medium text-ink">{proc.name}</td>
              <td className="py-2 pr-3">
                {proc.online === null ? (
                  <Badge variant="muted">unknown</Badge>
                ) : proc.online ? (
                  <Badge variant="success">{proc.status ?? "online"}</Badge>
                ) : (
                  <Badge variant="danger">{proc.status ?? "down"}</Badge>
                )}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-ink-muted">
                {proc.restarts == null ? "—" : formatCount(proc.restarts)}
              </td>
              {/* Coloured against prod's 900M max_memory_restart ceiling — past
                  it, pm2 kills the process mid-request. */}
              <td
                className={`py-2 pr-3 text-right tabular-nums ${
                  proc.mem_severity === "crit"
                    ? "text-danger"
                    : proc.mem_severity === "warn"
                      ? "text-warning"
                      : "text-ink-muted"
                }`}
              >
                {proc.mem_mb == null ? "—" : `${formatCount(proc.mem_mb)} MB`}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-ink-muted">
                {proc.cpu_pct == null ? "—" : `${proc.cpu_pct}%`}
              </td>
              <td className="py-2 text-right tabular-nums text-ink-muted">
                {formatDuration(proc.uptime_s ?? null)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NotConfigured() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">No hosts configured</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-ink-muted">
        <p>
          <code>OPS_INGEST_HOSTS</code> is not set on this environment, so no
          host is allowed to push metrics and there is nothing to show.
        </p>
        <p>
          Set <code>OPS_INGEST_HOSTS=prod,sandbox,iot</code> and{" "}
          <code>OPS_INGEST_SECRET</code> on the CRM, then install the agent — see{" "}
          <code>ops-agent/README.md</code>.
        </p>
      </CardContent>
    </Card>
  );
}

export default async function OperationsInfrastructurePage() {
  let view: Awaited<ReturnType<typeof getInfrastructureView>>;
  try {
    view = await getInfrastructureView();
  } catch (e) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-danger">
            Metric samples unavailable
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

  if (view.hosts.length === 0) return <NotConfigured />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-muted">
          Pushed by <code>ops-agent</code> every 5 minutes. The CRM never
          connects to a box.
        </p>
        <AutoRefresh intervalMs={30_000} />
      </div>

      {view.hosts.map((host) => (
        <Card key={host.host}>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base capitalize">{host.host}</CardTitle>
              <p className="mt-1 text-xs text-ink-muted">
                {host.never_reported
                  ? "This host has never posted. Every tile below is empty until the agent runs."
                  : "CPU, memory, disk, inodes, swap, SSL and pm2, with 24h trend."}
              </p>
            </div>
            <AgentBadge host={host} />
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              {host.metrics.map((metric) => (
                <MetricTile key={metric.key} metric={metric} />
              ))}
            </div>
            <ProcessTable host={host} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
