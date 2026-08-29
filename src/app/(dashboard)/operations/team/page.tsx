import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCount, formatMetricValue, formatMinutesAgo } from "@/lib/operations/format";
import { getTeamView } from "@/lib/operations/team";

import { AutoRefresh } from "../_components/AutoRefresh";

export const metadata = { title: "Team · Ops Console" };

/**
 * Licence and capacity monitoring — how many seats are in use, how many
 * accounts were provisioned and forgotten, whether system activity collapsed.
 *
 * THIS PAGE is aggregate only. The sign-in buckets are counts; the by-role and
 * top-actor tables are read live from audit_logs and never stored as a time
 * series, so no per-employee history accumulates here. `audit_logs` records
 * write-shaped work only — somebody who spent the day reading dashboards appears
 * as zero, which is why none of this should be read as effort.
 *
 * Per-person sign-in history and session duration live on /operations/usage
 * (E-214), behind their own role set and retention. The on-screen caption says
 * so: a page promising something the console next door no longer does would be
 * worse than saying nothing.
 */

export default async function OperationsTeamPage() {
  let view: Awaited<ReturnType<typeof getTeamView>>;
  try {
    view = await getTeamView();
  } catch (e) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-danger">
            Team metrics unavailable
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

  const unavailable = view.metrics.find((m) => m.unavailable);
  const maxRoleActions = Math.max(...view.by_role.map((r) => r.actions), 1);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-muted">
          Aggregate only on this page — licence and capacity. Per-person sign-in
          history and session detail live on{" "}
          <Link
            href="/operations/usage"
            className="font-semibold text-brand-700 underline-offset-2 hover:underline"
          >
            Usage
          </Link>
          . Sign-in counts here come from Supabase and measure sign-in{" "}
          <em>recency</em>, so they read higher than Usage&rsquo;s observed
          sessions.
        </p>
        <AutoRefresh intervalMs={60_000} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accounts &amp; activity</CardTitle>
          <p className="mt-1 text-xs text-ink-muted">
            Sign-in data comes from the Supabase Admin API — sessions live in{" "}
            <code>auth.users</code>, not in our Postgres, and{" "}
            <code>users</code> has no last-login column.
          </p>
        </CardHeader>
        <CardContent>
          {unavailable && (
            <p className="mb-3 rounded-lg border border-danger/40 bg-danger-bg/40 p-2 text-[11px] text-danger">
              {unavailable.unavailable}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {view.metrics.map((metric) => (
              <div
                key={metric.key}
                className="rounded-lg border border-border p-3"
                title={metric.help}
              >
                <div className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                  {metric.label}
                </div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-ink">
                  {metric.value == null
                    ? "—"
                    : formatMetricValue(metric.value, metric.unit)}
                </div>
                {metric.age_minutes != null && (
                  <div className="mt-1 text-[10px] text-ink-muted">
                    {formatMinutesAgo(metric.age_minutes)}
                  </div>
                )}
              </div>
            ))}
          </div>
          {view.never_collected && (
            <p className="mt-3 text-[11px] text-ink-muted">
              Nothing collected yet — the <code>team.usage</code> collector runs
              hourly. Check <code>/operations/jobs</code>.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Audited actions by role</CardTitle>
              <p className="mt-1 text-xs text-ink-muted">
                Last 30 days. A role at zero means nobody in it performed a
                write-shaped action, not that nobody worked.
              </p>
            </div>
            <Badge variant="muted">{formatCount(view.actions_30d)} total</Badge>
          </CardHeader>
          <CardContent>
            {view.by_role.length === 0 ? (
              <p className="text-sm text-ink-muted">
                No audited actions in the window.
              </p>
            ) : (
              <div className="space-y-2">
                {view.by_role.map((role) => (
                  <div key={role.role} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="font-medium text-ink">{role.role}</span>
                      <span className="tabular-nums text-ink-muted">
                        {formatCount(role.actions)} by {role.actors}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-bg">
                      <div
                        className="h-full bg-brand-navy"
                        style={{
                          width: `${(role.actions / maxRoleActions) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top actors</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Last 30 days, top 10. Present to answer &ldquo;is one integration
              account doing all the writing?&rdquo; — counts only, no drill-down.
            </p>
          </CardHeader>
          <CardContent>
            {view.top_actors.length === 0 ? (
              <p className="text-sm text-ink-muted">No audited actions.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {view.top_actors.map((actor) => (
                    <tr
                      key={`${actor.name}-${actor.role}`}
                      className="border-b border-border/60 last:border-0"
                    >
                      <td className="py-2 pr-3 text-ink">{actor.name}</td>
                      <td className="py-2 pr-3 text-[11px] text-ink-muted">
                        {actor.role}
                      </td>
                      <td className="py-2 text-right tabular-nums text-ink-muted">
                        {formatCount(actor.actions)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
