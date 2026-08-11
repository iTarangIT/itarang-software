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
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-3xl text-xs text-ink-muted">
          Read from <code>pg_stat_*</code> every 2 minutes. No CloudWatch, no
          extra IAM.{" "}
          <span className="text-ink">
            Cache hit ratio, rollback ratio, deadlocks and the read/write rates
            are measured <strong>over the last collection interval</strong>, not
            since the database was created.
          </span>{" "}
          The <code>pg_stat_database</code> columns behind them are counters that
          only ever climb, so as lifetime averages they sat frozen — this
          instance&apos;s lifetime cache hit ratio is 100.00% against a
          denominator of a billion blocks, which no cache collapse today could
          move. Cache hit ratio covers <em>shared buffers only</em>: a miss may
          still be served by the OS page cache without touching a disk.
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
          <CardContent className="space-y-4">
            {instance.unreachable ? (
              <p className="text-sm text-danger" title={instance.unreachable}>
                {instance.unreachable}
              </p>
            ) : (
              <>
                {/* The raw pair behind the capacity percentage. Subtext rather
                    than two more tiles — a count, a ceiling and the percentage
                    of one over the other are one measurement, not three. */}
                {instance.connections_used != null &&
                  instance.connections_usable != null && (
                    <p className="text-xs text-ink-muted">
                      <span className="font-semibold tabular-nums text-ink">
                        {formatCount(instance.connections_used)}
                      </span>{" "}
                      of{" "}
                      <span className="font-semibold tabular-nums text-ink">
                        {formatCount(instance.connections_usable)}
                      </span>{" "}
                      usable connections
                      {instance.max_connections != null && (
                        <>
                          {" "}
                          (max_connections {formatCount(instance.max_connections)},
                          less the superuser-reserved slots the application cannot
                          reach)
                        </>
                      )}
                      . Client backends only — background workers appear in{" "}
                      <code>pg_stat_activity</code> but consume no slot.
                    </p>
                  )}

                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                  {instance.metrics.map((metric) => (
                    <MetricTile key={metric.key} metric={metric} />
                  ))}
                </div>

                {instance.clients.length > 0 && (
                  <div>
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      Where the connections come from
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[26rem] text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                            <th className="py-2 pr-3">Application</th>
                            <th className="py-2 pr-3">Database</th>
                            <th className="py-2 pr-3">User</th>
                            <th className="py-2 pr-3 text-right">Conns</th>
                            <th className="py-2 text-right">Active</th>
                          </tr>
                        </thead>
                        <tbody>
                          {instance.clients.map((client) => (
                            <tr
                              key={`${client.application}|${client.database}|${client.username}`}
                              className="border-b border-border/60 last:border-0"
                            >
                              <td className="py-2 pr-3 font-mono text-[12px] text-ink">
                                {client.application}
                              </td>
                              <td className="py-2 pr-3 text-[12px] text-ink-muted">
                                {client.database ?? "—"}
                              </td>
                              <td className="py-2 pr-3 text-[12px] text-ink-muted">
                                {client.username ?? "—"}
                              </td>
                              <td className="py-2 pr-3 text-right tabular-nums text-ink">
                                {formatCount(client.connections)}
                              </td>
                              <td className="py-2 text-right tabular-nums text-ink-muted">
                                {formatCount(client.active)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
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
