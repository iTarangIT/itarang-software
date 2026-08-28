import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatCount, formatIst } from "@/lib/operations/format";
import {
  getDatabaseView,
  type DatabaseInstanceView,
  type DatabaseView,
} from "@/lib/operations/views";

import { AutoRefresh } from "../_components/AutoRefresh";
import { MetricTile } from "../_components/MetricTile";

export const metadata = { title: "Database · Ops Console" };

/**
 * Database health, pulled by plain SQL against the databases themselves.
 *
 * One card per database. Each card answers, in this order: is it up, what IS it
 * (tables, columns, size), how close is it to running out of connections, how
 * hard is it working, where are the connections coming from, and what is big.
 *
 * Connection headroom leads inside the card because it is the number that takes
 * the site down: RDS has ~79 max_connections and no pooler, each process opens
 * its own pool, and a deploy burst trips 53300 — which fails /api/health and
 * rolls the deploy back.
 *
 * Note /api/system/database-monitor looks like it already does this. It calls
 * getIotSql(), so it reports the IoT database rather than the CRM despite its
 * name and its requireRole(['ceo']) gate. It is not reused here.
 */

/** Structural facts about a database — what it IS, not how it is doing. */
function IdentityStrip({ instance }: { instance: DatabaseInstanceView }) {
  const { identity } = instance;
  const facts: Array<{ label: string; value: string }> = [];

  if (identity.tables != null) {
    facts.push({ label: "Tables", value: formatCount(identity.tables) });
  }
  if (identity.columns != null) {
    facts.push({ label: "Columns", value: formatCount(identity.columns) });
  }
  if (identity.size_bytes != null) {
    facts.push({ label: "Size", value: formatBytes(identity.size_bytes) });
  }
  if (identity.database) {
    facts.push({ label: "Database", value: identity.database });
  }
  if (identity.major_version != null) {
    facts.push({ label: "Postgres", value: String(identity.major_version) });
  }

  if (facts.length === 0) return null;

  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg border border-border bg-bg px-3 py-2">
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            {fact.label}
          </dt>
          <dd className="font-mono text-sm tabular-nums text-ink">
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** What this process announces, for the diagnostic line under the table. */
type SelfIdentity = DatabaseView["this_process"];

function ConnectionTable({
  instance,
  self,
}: {
  instance: DatabaseInstanceView;
  /** Only shown for the CRM card — the IoT pool is a different connection. */
  self?: SelfIdentity;
}) {
  // Without pg_monitor this role sees only its own backends, so a count here
  // would describe the monitor rather than the database. Say so; do not show a
  // small number that looks like an answer.
  if (!instance.can_see_all_backends) {
    return (
      <p className="text-xs text-ink-muted">
        Connection attribution is unavailable: the role this connection uses
        (<code>{instance.identity.username ?? "unknown"}</code>) is not a member
        of <code>pg_monitor</code>, so <code>pg_stat_activity</code> shows only
        this application&apos;s own backends. A count taken from it would
        describe the monitor, not the database.
      </p>
    );
  }

  if (instance.clients.length === 0) return null;

  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        Where the connections come from
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[42rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
              <th className="py-2 pr-3">Application</th>
              <th className="py-2 pr-3">Client</th>
              <th className="py-2 pr-3">Database</th>
              <th className="py-2 pr-3">User</th>
              <th className="py-2 pr-3 text-right">Conns</th>
              <th className="py-2 pr-3 text-right">Active</th>
              <th className="py-2 pr-3 text-right">Idle</th>
              <th className="py-2 pr-3 text-right">Idle in txn</th>
              <th className="py-2 text-right">Oldest</th>
            </tr>
          </thead>
          <tbody>
            {instance.clients.map((client) => (
              <tr
                key={`${client.application}|${client.client_host}|${client.database}|${client.username}`}
                className="border-b border-border/60 last:border-0"
              >
                {/* A driver default is not an identity. Showing `postgres.js`
                    as though it were an application name is what made this
                    table unable to answer "which service is this?" — so it is
                    named for what it is, and the client address carries the
                    distinction instead. */}
                <td className="py-2 pr-3 text-[12px]">
                  {!client.is_driver_default ? (
                    <span className="font-mono text-ink">
                      {client.application}
                    </span>
                  ) : client.application === "(unnamed)" ? (
                    // The backend sent no application_name at all, so there is
                    // no driver string to attribute it to either.
                    <span className="text-ink-muted">unnamed</span>
                  ) : (
                    <span className="text-ink-muted">
                      unnamed
                      <span className="ml-1 font-mono text-[11px] opacity-70">
                        · {client.application} default
                      </span>
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 font-mono text-[12px] text-ink-muted">
                  {client.client_host ?? "—"}
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
                <td className="py-2 pr-3 text-right tabular-nums text-ink-muted">
                  {formatCount(client.active)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-ink-muted">
                  {formatCount(client.idle)}
                </td>
                <td
                  className={`py-2 pr-3 text-right tabular-nums ${
                    client.idle_tx > 0 ? "text-warning" : "text-ink-muted"
                  }`}
                >
                  {formatCount(client.idle_tx)}
                </td>
                <td className="py-2 text-right tabular-nums text-ink-muted">
                  {client.oldest_state_s == null
                    ? "—"
                    : `${formatCount(client.oldest_state_s)}s`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-ink-muted">
        Grouped by <code>application_name</code> and client address.
        &ldquo;Oldest&rdquo; is how long the least-recently-changed backend in
        the group has been in its current state. Rows marked{" "}
        <em>unnamed</em> come from a process that declared no name, so the
        client address is the only thing separating them — two developers behind
        one office address would appear as one row, and the{" "}
        <code>rdsadmin</code> rows are AWS RDS&apos;s own tooling, which we
        cannot name.
      </p>
      {self && (
        <p className="mt-1 text-[11px] text-ink-muted">
          This server announces itself as{" "}
          {self.application_name ? (
            <>
              <code className="text-ink">{self.application_name}</code> (from{" "}
              <code>{self.source}</code>)
            </>
          ) : (
            <>
              <span className="text-warning">nothing</span> — no{" "}
              <code>OPS_APP_NAME</code> or <code>PGAPPNAME</code> in this
              process&apos;s environment and no pm2 name, so its own connections
              appear above as unnamed. Set <code>OPS_APP_NAME</code> in the{" "}
              <code>env</code> block of the matching{" "}
              <code>ecosystem.*.config.js</code> and reload with{" "}
              <code>--update-env</code>
            </>
          )}
          .
        </p>
      )}
    </div>
  );
}

function LargestTables({ instance }: { instance: DatabaseInstanceView }) {
  if (instance.tables.length === 0) return null;

  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        Largest tables
      </p>
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
            {instance.tables.map((table) => (
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
      <p className="mt-2 text-[11px] text-ink-muted">
        Union of the top 20 by total relation size and the top 20 by row count —
        the biggest table on disk and the one with the most rows are usually
        different tables. Row counts are <code>pg_stat_user_tables</code>{" "}
        estimates, not <code>count(*)</code>.
      </p>
    </div>
  );
}

/**
 * The hypervisor's view of the instance: CPU, memory, volume, disk queue and
 * burst credits.
 *
 * A SECOND GRID INSIDE THE SAME CARD, not a second card and not a merge into
 * the grid above. These numbers describe the same database, so they belong on
 * its card — but they come from a different source with a different freshness
 * and a different failure mode, and an operator reading a stale CPU figure next
 * to a live connection count needs to know which is which. The caption line is
 * the whole of that distinction.
 */
function InstanceMetrics({ instance }: { instance: DatabaseInstanceView }) {
  const { instance_metrics: metrics, instance_metrics_state: state } = instance;

  // Not switched on. One line, not a row of empty tiles — the same reasoning
  // that gives an unconfigured database prose instead of a blank card.
  if (!state.configured) {
    return (
      <p className="text-xs text-ink-muted">
        Instance metrics (CPU, memory, storage, disk queue) are not enabled. Set{" "}
        <code>OPS_RDS_INSTANCE_ID</code> on this host to collect them from
        CloudWatch. Nothing was asked, so nothing is claimed.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        Instance · CloudWatch
        {state.identifier && (
          <span className="ml-2 font-mono normal-case tracking-normal">
            {state.identifier}
          </span>
        )}
      </p>

      {state.error ? (
        /* An IAM, credential or network failure. Said plainly, and pointedly
           NOT allowed to affect the pg_stat_* tiles above — those come from the
           database connection and are still true. */
        <p className="text-xs text-danger" title={state.error}>
          {state.error}
        </p>
      ) : metrics.length === 0 ? (
        <p className="text-xs text-ink-muted">
          No readings yet. The <code>db.cloudwatch</code> collector runs every 5
          minutes.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {metrics.map((metric) => (
            <MetricTile key={metric.key} metric={metric} />
          ))}
        </div>
      )}
    </div>
  );
}

function InstanceCard({
  instance,
  self,
}: {
  instance: DatabaseInstanceView;
  self?: SelfIdentity;
}) {
  const subtitle =
    instance.source === "rds:crm"
      ? "AWS RDS PostgreSQL — the CRM's own database"
      : instance.source === "rds:iot"
        ? "VPS PostgreSQL over the SSH tunnel — vehicle telemetry"
        : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">{instance.label}</CardTitle>
          {subtitle && (
            <p className="mt-1 text-xs text-ink-muted">{subtitle}</p>
          )}
          <p className="mt-1 font-mono text-[11px] text-ink-muted">
            {instance.source}
            {instance.target ? ` · ${instance.target}` : ""}
          </p>
        </div>
        {instance.not_configured ? (
          <Badge variant="muted">Not configured</Badge>
        ) : instance.unreachable ? (
          <Badge variant="danger">Unreachable</Badge>
        ) : instance.identity.tables != null ||
          instance.connections_used != null ? (
          <Badge variant="success">Live</Badge>
        ) : (
          <Badge variant="muted">No samples yet</Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {instance.not_configured ? (
          /* Not a fault. This deployment has no connection string for this
             database, which is a different statement from "we tried and
             failed" — and the previous version of this page could not tell
             them apart because an unconfigured instance simply had no card. */
          <div className="space-y-2 text-sm text-ink-muted">
            <p>{instance.not_configured}</p>
            <p className="text-xs">
              Nothing was probed, so nothing is claimed about this database. Set{" "}
              <code>IOT_DATABASE_URL</code> on this host to enable it.
            </p>
          </div>
        ) : instance.unreachable ? (
          <div className="space-y-2">
            <p className="text-sm text-danger" title={instance.unreachable}>
              {instance.unreachable}
            </p>
            {instance.target && (
              <p className="text-xs text-ink-muted">
                Dialled <code>{instance.target}</code>. This connection goes
                through an SSH tunnel to a loopback port, so a refused
                connection means either the tunnel is not running or it is
                listening on a different port than this environment expects —
                see <code>docs/intellicar-live-data-vps-setup.md</code>. Both
                are host-level fixes; nothing in the application can restore
                them.
              </p>
            )}
          </div>
        ) : (
          <>
            <IdentityStrip instance={instance} />

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
                  .
                  {instance.background_workers != null && (
                    <>
                      {" "}
                      Client backends only — the{" "}
                      {formatCount(instance.background_workers)} background
                      workers alongside them (checkpointer, walwriter, the
                      autovacuum and replication launchers) appear in{" "}
                      <code>pg_stat_activity</code> but consume no slot.
                    </>
                  )}
                </p>
              )}

            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                Postgres · pg_stat_*
              </p>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                {instance.metrics.map((metric) => (
                  <MetricTile key={metric.key} metric={metric} />
                ))}
              </div>
            </div>

            {/* Only the CRM instance. The IoT database is reached through an
                SSH tunnel to a bastion and lives in a different RDS resource
                namespace, almost certainly a different AWS account — asking
                this account's CloudWatch about it would fail every cycle to
                tell us nothing. */}
            {instance.source === "rds:crm" && (
              <InstanceMetrics instance={instance} />
            )}

            {instance.identity.dead_tuples != null && (
              <p className="text-xs text-ink-muted">
                <span className="font-semibold tabular-nums text-ink">
                  {formatCount(instance.identity.dead_tuples)}
                </span>{" "}
                dead rows awaiting vacuum. The share beside it is what alerts —
                a fixed row count cannot be a threshold across tables of wildly
                different sizes.
              </p>
            )}

            <ConnectionTable instance={instance} self={self} />
            <LargestTables instance={instance} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

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

  const anySamples = view.instances.some(
    (i) => i.connections_used != null || i.identity.tables != null,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-3xl text-xs text-ink-muted">
          Postgres tiles are read from <code>pg_stat_*</code> every 2 minutes
          over the app&apos;s own connection. Instance tiles — CPU, memory,
          storage, disk queue — come from CloudWatch every 5 minutes and are
          stamped with the datapoint&apos;s own time, since CloudWatch publishes
          2-3 minutes late; they are absent unless{" "}
          <code>OPS_RDS_INSTANCE_ID</code> is set, and a CloudWatch failure
          never affects the numbers above it.{" "}
          <span className="text-ink">
            The query, transaction, read and write rates, the cache hit ratio,
            the rollback ratio and the deadlock count are all measured{" "}
            <strong>over the last collection interval</strong>, not since the
            database was created.
          </span>{" "}
          The <code>pg_stat_database</code> columns behind them are counters
          that only ever climb, so as lifetime averages they sat frozen — this
          instance&apos;s lifetime cache hit ratio is 100.00% against a
          denominator of a billion blocks, which no cache collapse today could
          move. Cache hit ratio covers <em>shared buffers only</em>: a miss may
          still be served by the OS page cache without touching a disk.
        </p>
        <AutoRefresh intervalMs={30_000} />
      </div>

      {!anySamples && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Waiting for the first run</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-ink-muted">
            The <code>db.rds</code> collector has not written any samples yet.
            It runs every 2 minutes on the in-process ticker — check{" "}
            <code>/operations/jobs</code>, where a failure would be recorded
            with its error.
          </CardContent>
        </Card>
      )}

      {view.instances.map((instance) => (
        <InstanceCard
          key={instance.source}
          instance={instance}
          // Only the CRM card: this process's pool connects to the CRM
          // database, so claiming the same identity under the IoT card would
          // describe a connection that is not the one being listed.
          self={instance.source === "rds:crm" ? view.this_process : undefined}
        />
      ))}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Schema drift</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Tables declared in <code>schema.ts</code> that the CRM database
              does not have — i.e. unapplied migrations. Drizzle names every
              column in its INSERTs, so a missing table is a 500 on first write,
              not a degraded read. <strong>Table names only:</strong> a column
              added to an existing table is invisible here, which is exactly how
              the <code>expense_submissions</code> column drift went unnoticed.
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
            <p>Every table in schema.ts exists on the CRM database.</p>
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

      {view.last_updated && (
        <p className="text-[11px] text-ink-muted">
          Sampled {formatIst(view.last_updated, { withSeconds: true })}
        </p>
      )}
    </div>
  );
}
