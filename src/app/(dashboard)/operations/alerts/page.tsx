import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatIst, formatMetricValue, formatMinutesAgo, minutesSince } from "@/lib/operations/format";
import { getAlertsView, type AlertRow } from "@/lib/operations/alertsView";

import { ANY_SOURCE } from "@/lib/operations/alertRouting";

import { AlertActions } from "../_components/AlertActions";
import { AutoRefresh } from "../_components/AutoRefresh";
import { RuleCreator } from "../_components/RuleCreator";
import { RuleEditor } from "../_components/RuleEditor";

export const metadata = { title: "Alerts · Ops Console" };

/**
 * Open alerts and the thresholds that produce them.
 *
 * Rules are seeded from registry.ts defaults the first time the runner sees a
 * metric, and owned by whoever edits them here afterwards — the seed uses
 * ON CONFLICT DO NOTHING precisely so a hand-tuned threshold survives a deploy.
 *
 * Delivery is in-app via notifyRoles(["operations"]) plus optional email, gated
 * by cooldown_minutes so a metric sitting on its boundary cannot spam.
 */

function AlertTable({
  alerts,
  resolved,
}: {
  alerts: AlertRow[];
  resolved?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[48rem] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            <th className="py-2 pr-3">Severity</th>
            <th className="py-2 pr-3">Alert</th>
            <th className="py-2 pr-3 text-right">Value</th>
            <th className="py-2 pr-3 text-right">Threshold</th>
            <th className="py-2 pr-3">{resolved ? "Resolved" : "Age"}</th>
            {!resolved && <th className="py-2" />}
          </tr>
        </thead>
        <tbody>
          {alerts.map((alert) => (
            <tr
              key={alert.id}
              className="border-b border-border/60 align-top last:border-0"
            >
              <td className="py-2.5 pr-3">
                <Badge variant={alert.severity === "crit" ? "danger" : "warning"}>
                  {alert.severity}
                </Badge>
                {alert.acknowledged_at && !resolved && (
                  <div className="mt-1">
                    <Badge variant="muted">ack</Badge>
                  </div>
                )}
              </td>
              <td className="py-2.5 pr-3">
                <div className="text-ink">{alert.message}</div>
                <div className="mt-0.5 font-mono text-[11px] text-ink-muted">
                  {alert.metric_key} · {alert.source}
                </div>
              </td>
              <td className="py-2.5 pr-3 text-right tabular-nums text-ink">
                {alert.value_num == null
                  ? "—"
                  : formatMetricValue(alert.value_num, alert.unit)}
              </td>
              <td className="py-2.5 pr-3 text-right tabular-nums text-ink-muted">
                {alert.threshold == null
                  ? "—"
                  : formatMetricValue(alert.threshold, alert.unit)}
              </td>
              <td className="py-2.5 pr-3 text-xs text-ink-muted">
                {resolved ? (
                  formatIst(alert.resolved_at)
                ) : (
                  <>
                    <div>{formatMinutesAgo(minutesSince(alert.opened_at))}</div>
                    <div className="text-[10px]">{formatIst(alert.opened_at)}</div>
                  </>
                )}
              </td>
              {!resolved && (
                <td className="py-2.5 pl-3">
                  <AlertActions
                    alertId={alert.id}
                    acknowledged={alert.acknowledged_at != null}
                  />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function OperationsAlertsPage() {
  let view: Awaited<ReturnType<typeof getAlertsView>>;
  try {
    view = await getAlertsView();
  } catch (e) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-danger">Alerts unavailable</CardTitle>
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

  const crit = view.open.filter((a) => a.severity === "crit").length;

  // Which sources each '*' rule has lost to an override, so the table can say
  // so on the wildcard row rather than leaving the operator to infer it.
  const shadowed = new Map<string, string[]>();
  for (const rule of view.rules) {
    if (rule.source === ANY_SOURCE || !rule.enabled) continue;
    shadowed.set(rule.metric_key, [
      ...(shadowed.get(rule.metric_key) ?? []),
      rule.source,
    ]);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Open alerts</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Acknowledging marks an alert as seen but leaves it open while the
              condition holds. Resolving closes it — it re-opens on the next tick
              if the breach is still live.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={crit > 0 ? "danger" : "muted"}>{crit} critical</Badge>
            <Badge variant={view.open.length > 0 ? "warning" : "muted"}>
              {view.open.length} open
            </Badge>
            <AutoRefresh intervalMs={30_000} />
          </div>
        </CardHeader>
        <CardContent>
          {view.open.length === 0 ? (
            <p className="py-4 text-center text-sm text-ink-muted">
              Nothing is breaching a threshold.
            </p>
          ) : (
            <AlertTable alerts={view.open} />
          )}
        </CardContent>
      </Card>

      {view.recent_resolved.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recently resolved</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              The last 20 to recover. &ldquo;Did that come back?&rdquo; is the
              second question anyone asks.
            </p>
          </CardHeader>
          <CardContent>
            <AlertTable alerts={view.recent_resolved} resolved />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Thresholds</CardTitle>
          <p className="mt-1 text-xs text-ink-muted">
            Seeded from the metric registry, then owned here — edits survive
            deploys. Blank means no threshold at that level. Cooldown is the
            minimum gap between notifications for the same rule. A rule naming a
            specific source overrides <code>*</code> for that source only.
          </p>
        </CardHeader>
        <CardContent>
          {view.rules.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No rules yet — they seed on the first collector tick.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[48rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    <th className="py-2 pr-3">Metric</th>
                    <th className="py-2 pr-2 text-right">Warn</th>
                    <th className="py-2 pr-2 text-right">Crit</th>
                    <th className="py-2 pr-2 text-right">Cooldown</th>
                    <th className="py-2 pr-2 text-center">Email</th>
                    <th className="py-2 pr-2 text-center">On</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {view.rules.map((rule) => (
                    <RuleEditor
                      key={rule.id}
                      rule={rule}
                      shadowedFor={
                        rule.source === ANY_SOURCE ? shadowed.get(rule.metric_key) : undefined
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <RuleCreator options={view.metric_options} />
        </CardContent>
      </Card>
    </div>
  );
}
