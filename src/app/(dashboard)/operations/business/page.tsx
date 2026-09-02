import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatMetricValue,
  formatMinutesAgo,
} from "@/lib/operations/format";
import { getBusinessView, type BusinessRow } from "@/lib/operations/business";

import { AutoRefresh } from "../_components/AutoRefresh";

export const metadata = { title: "Business · Ops Console" };

/**
 * A read-only mirror of the CEO dashboard's numbers.
 *
 * The tech team's use for this is narrow: a pipeline that breaks after a deploy
 * shows up as a number going to zero here, hours before anyone in sales
 * notices. That is why "Leads created" carries a warn threshold of 1 — zero
 * leads mid-month is a broken ingest, not a quiet week.
 *
 * Every figure is shown twice — computed live, and as the collector last stored
 * it. Matching values mean the mirror is faithful; a gap means either the
 * collector has stopped or something moved underneath it.
 */

function severityBadge(row: BusinessRow) {
  if (row.severity === "crit") return <Badge variant="danger">Critical</Badge>;
  if (row.severity === "warn") return <Badge variant="warning">Warn</Badge>;
  return null;
}

export default async function OperationsBusinessPage() {
  let view: Awaited<ReturnType<typeof getBusinessView>>;
  try {
    view = await getBusinessView();
  } catch (e) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-danger">
            Business metrics unavailable
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-ink-muted">
          <pre className="overflow-x-auto rounded-lg bg-bg p-3 text-[11px] text-ink">
            {e instanceof Error ? e.message : String(e)}
          </pre>
        </CardContent>
      </Card>
    );
  }

  const drifted = view.rows.filter((r) => r.drifted);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Business metrics</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              The same aggregations the CEO dashboard renders — same filters,
              same window ({view.window.startStr} to {view.window.endStr}).
              Revenue excludes only void invoices; outstanding also excludes
              drafts.
            </p>
          </div>
          <AutoRefresh intervalMs={60_000} />
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            {view.never_collected ? (
              <Badge variant="muted">Not yet collected</Badge>
            ) : drifted.length === 0 ? (
              <Badge variant="success">Collector matches live</Badge>
            ) : (
              <Badge variant="warning">{drifted.length} drifted</Badge>
            )}
            <span className="text-ink-muted">
              Last collected {formatMinutesAgo(view.collected_age_minutes)}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  <th className="py-2 pr-3">Metric</th>
                  <th className="py-2 pr-3 text-right">Live</th>
                  <th className="py-2 pr-3 text-right">Collected</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr
                    key={row.key}
                    className="border-b border-border/60 align-top last:border-0"
                  >
                    <td className="py-2.5 pr-3">
                      <div className="font-medium text-ink">{row.label}</div>
                      <div className="font-mono text-[11px] text-ink-muted">
                        {row.key}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-right font-semibold tabular-nums text-ink">
                      {formatMetricValue(row.live, row.unit)}
                    </td>
                    <td
                      className={`py-2.5 pr-3 text-right tabular-nums ${
                        row.drifted ? "text-warning" : "text-ink-muted"
                      }`}
                    >
                      {row.collected == null
                        ? "—"
                        : formatMetricValue(row.collected, row.unit)}
                    </td>
                    <td className="py-2.5 pr-3">{severityBadge(row)}</td>
                    <td
                      className="max-w-[26rem] py-2.5 text-[11px] text-ink-muted"
                      title={row.help}
                    >
                      {row.drifted
                        ? `Collector wrote a different value ${formatMinutesAgo(row.age_minutes)} — it may have stopped.`
                        : (row.help ?? "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
