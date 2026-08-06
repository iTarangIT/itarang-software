import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatCount, formatIst } from "@/lib/operations/format";
import { getDatabaseView } from "@/lib/operations/views";

import { AutoRefresh } from "../_components/AutoRefresh";
import { MetricTile } from "../_components/MetricTile";

export const metadata = { title: "Database · Ops Console" };

/**
 * RDS health, pulled by plain SQL against the databases themselves.
 *
 * Connection headroom leads because it is the number that takes the site down:
 * RDS has ~79 max_connections and no pooler, each process opens its own pool,
 * and a deploy burst trips 53300 — which fails /api/health and rolls the deploy
 * back. Everything else on this page is context for that one tile.
 *
 * Note /api/system/database-monitor looks like it already does this. It calls
 * getIotSql(), so it reports the IoT VPS database rather than RDS despite its
 * name and its requireRole(['ceo']) gate. It is not reused here.
 */

export default async function OperationsDatabasePage() {
  let view: Awaited<ReturnType<typeof getDatabaseView>>;
  try {
    view = await getDatabaseView();
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

  if (view.instances.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Waiting for the first run</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-ink-muted">
          The <code>db.rds</code> collector has not written any samples yet. It
          runs every 2 minutes on the in-process ticker — check{" "}
          <code>/operations/jobs</code>, where a failure would be recorded with
          its error.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-muted">
          Read from <code>pg_stat_*</code> every 2 minutes. No CloudWatch, no
          extra IAM.
        </p>
        <AutoRefresh intervalMs={30_000} />
      </div>

      {view.instances.map((instance) => (
        <Card key={instance.source}>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">{instance.label}</CardTitle>
              <p className="mt-1 font-mono text-[11px] text-ink-muted">
                {instance.source}
              </p>
            </div>
            {instance.unreachable ? (
              <Badge variant="danger">Unreachable</Badge>
            ) : (
              <Badge variant="muted">Live</Badge>
            )}
          </CardHeader>
          <CardContent>
            {instance.unreachable ? (
              <p className="text-sm text-danger" title={instance.unreachable}>
                {instance.unreachable}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                {instance.metrics.map((metric) => (
                  <MetricTile key={metric.key} metric={metric} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Schema drift</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Tables declared in <code>schema.ts</code> that this database does
              not have — i.e. unapplied migrations. Drizzle names every column in
              its INSERTs, so a missing table is a 500 on first write, not a
              degraded read.
            </p>
          </div>
          {view.drift.unavailable ? (
            <Badge variant="muted">Unavailable</Badge>
          ) : view.drift.count === 0 ? (
            <Badge variant="success">In sync</Badge>
          ) : (
            <Badge variant={(view.drift.count ?? 0) >= 5 ? "danger" : "warning"}>
              {view.drift.count} missing
            </Badge>
          )}
        </CardHeader>
        <CardContent className="text-sm text-ink-muted">
          {view.drift.unavailable ? (
            <p className="text-danger">{view.drift.unavailable}</p>
          ) : view.drift.missing.length === 0 ? (
            <p>Every table in schema.ts exists on the CRM RDS.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {view.drift.missing.map((table) => (
                <li
                  key={table}
                  className="rounded-md border border-border bg-bg px-2 py-0.5 font-mono text-[11px]"
                >
                  {table}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Largest tables (CRM RDS)</CardTitle>
          <p className="mt-1 text-xs text-ink-muted">
            Union of the top 20 by total relation size and the top 20 by row
            count — the biggest table on disk and the one with the most rows are
            usually different tables. Row counts are{" "}
            <code>pg_stat_user_tables</code> estimates, not{" "}
            <code>count(*)</code>.
          </p>
        </CardHeader>
        <CardContent>
          {view.tables.length === 0 ? (
            <p className="text-sm text-ink-muted">No table samples yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[28rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    <th className="py-2 pr-3">Table</th>
                    <th className="py-2 pr-3 text-right">Size</th>
                    <th className="py-2 text-right">Rows (est.)</th>
                  </tr>
                </thead>
                <tbody>
                  {view.tables.map((table) => (
                    <tr
                      key={table.name}
                      className="border-b border-border/60 last:border-0"
                    >
                      <td className="py-2 pr-3 font-mono text-[12px] text-ink">
                        {table.name}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-ink-muted">
                        {formatBytes(table.bytes)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-ink-muted">
                        {table.rows == null ? "—" : formatCount(table.rows)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {view.last_updated && (
            <p className="mt-3 text-[11px] text-ink-muted">
              Sampled {formatIst(view.last_updated, { withSeconds: true })}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
