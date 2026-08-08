import { after } from "next/server";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatCount,
  formatIst,
  formatMetricValue,
  formatMinutesAgo,
} from "@/lib/operations/format";
import { requireUsageAnalyticsPage } from "@/lib/operations/route-guard";
import { getUsageView, type LoginEventRow } from "@/lib/operations/usage";
import { parseUsageFilters } from "@/lib/operations/usageMath";
import { recordUsageView } from "@/lib/usage/audit";

import { AutoRefresh } from "../_components/AutoRefresh";
import { UsageBarChart } from "../_components/UsageBarChart";
import { UsageFilterBar } from "../_components/UsageFilterBar";

export const metadata = { title: "CRM Usage · Ops Console" };

/**
 * CRM usage — logins, and (from Phase 2) session duration.
 *
 * THE ONLY PER-PERSON SURFACE IN THIS CONSOLE. Everything else under
 * /operations is aggregate, and that difference is why this page carries a
 * standing notice rather than a footnote: anyone reading it should be able to
 * see, without digging, exactly what is and is not recorded about their
 * colleagues.
 *
 * Guarded twice — once by operations/layout.tsx and again here via
 * requireUsageAnalyticsPage(). The layout's own comment argues that a per-page
 * gate is the failure mode to avoid, and it is right in general; this page is
 * the deliberate exception, because the layout gate is exactly the thing that
 * might be widened later for an unrelated reason.
 */

function LoginRow({ row }: { row: LoginEventRow }) {
  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="py-2.5 pr-3 text-ink">{formatIst(row.occurred_at)}</td>
      <td className="py-2.5 pr-3 text-ink">{row.name}</td>
      <td className="py-2.5 pr-3">
        <Badge variant="muted">{row.role}</Badge>
      </td>
      <td className="py-2.5 text-right text-ink-muted">{row.method}</td>
    </tr>
  );
}

export default async function OperationsUsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireUsageAnalyticsPage();

  const filters = parseUsageFilters(await searchParams);

  // Watching the watchers. This page names individuals, so opening it is itself
  // recorded — deduped per (viewer, subject) per hour, so the 60-second
  // auto-refresh does not bury the trail. after(), so an audit write never
  // delays the render. See src/lib/usage/audit.ts.
  after(async () => {
    await recordUsageView({
      viewerId: viewer.id,
      subjectId: filters.user ?? null,
      days: filters.days,
      surface: "page",
    });
  });

  let view: Awaited<ReturnType<typeof getUsageView>>;
  try {
    view = await getUsageView(filters);
  } catch (e) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-danger">
            Usage analytics unavailable
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-ink-muted">
          <pre className="overflow-x-auto rounded-lg bg-bg p-3 text-[11px] text-ink">
            {e instanceof Error ? e.message : String(e)}
          </pre>
          <p>
            If this says a relation does not exist, apply{" "}
            <code>drizzle/E-214_usage_analytics.sql</code> to this database.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Only people who appear in the current window — the filter must not double
  // as a staff directory.
  const people = [
    ...new Map(
      view.history.map((r) => [r.user_id, { id: r.user_id, name: r.name }]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const peakLogins = Math.max(...view.login_trend.map((d) => d.logins), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        {/* A standing notice, not a footnote. This is the only page in the
            console that names individuals, so what it does NOT collect belongs
            on screen where the people being measured can read it. */}
        <div className="rounded-lg border border-border bg-bg/60 p-3 text-xs text-ink-muted">
          <p className="font-semibold text-ink">
            Per-person data — recorded, retained, and deleted on a schedule.
          </p>
          <p className="mt-1">
            Records <strong>when someone signed in</strong>, their role at the
            time, and — while session tracking is enabled — the{" "}
            <strong>start and last-active time of each CRM session</strong> plus
            a count of activity pings taken every 5 minutes while the CRM tab is
            in the foreground.
          </p>
          <p className="mt-1">
            Does <strong>not</strong> record individual pages, records opened,
            searches, anything typed, IP address, or device. Sign-in records are
            deleted after 90 days and session records after 30 days; only
            day-level totals are kept beyond that. Readable by the{" "}
            <code>operations</code> login only. See §8 of the Ops Runbook.
          </p>
        </div>
        <AutoRefresh intervalMs={60_000} />
      </div>

      {view.never_collected && (
        <Card>
          <CardContent className="p-4 text-sm text-ink-muted">
            No samples yet. The <code>usage.activity</code> collector runs every
            15 minutes — open <code>/operations/jobs</code> and press{" "}
            <strong>Run now</strong> if you do not want to wait. The login
            history below reads the table directly and does not depend on it.
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {view.metrics.map((m) => (
          <div
            key={m.key}
            className="rounded-xl border border-border bg-surface p-3"
            title={m.help}
          >
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
              {m.label}
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
              {formatMetricValue(m.value, m.unit)}
            </p>
            {m.age_minutes != null && m.age_minutes > 30 && (
              <p className="mt-1 text-[10px] text-warning">
                {formatMinutesAgo(m.age_minutes)}
              </p>
            )}
          </div>
        ))}
        <div className="rounded-xl border border-border bg-surface p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            Logins in window
          </p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
            {formatCount(view.logins_in_window)}
          </p>
        </div>
        <div
          className="rounded-xl border border-border bg-surface p-3"
          title="Sessions started in this window. A session ends after 15 minutes idle, so one person can have several in a day — this is not a login count."
        >
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            Sessions in window
          </p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
            {formatCount(view.sessions.count)}
          </p>
          {view.sessions.active_now > 0 && (
            <p className="mt-1 text-[10px] text-success">
              {formatCount(view.sessions.active_now)} active now
            </p>
          )}
        </div>
        <div
          className="rounded-xl border border-border bg-surface p-3"
          title="Summed engaged time. Derived from heartbeat count, not wall-clock — a tab left open while the laptop slept does not count as work."
        >
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            Time in CRM
          </p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
            {view.sessions.count === 0
              ? "—"
              : formatMetricValue(view.sessions.minutes, "minutes")}
          </p>
          <p className="mt-1 text-[10px] text-ink-muted">
            {view.sessions.count === 0
              ? "session tracking not enabled yet"
              : `${formatCount(view.sessions.people)} people`}
          </p>
        </div>
        <div
          className="rounded-xl border border-border bg-surface p-3"
          title="Distinct accounts that entered a credential in this window. Lower than active users, because a live session does not need re-authenticating."
        >
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            People who signed in
          </p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
            {formatCount(view.people_in_window)}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Logins per day · last {view.filters.days}{" "}
            {view.filters.days === 1 ? "day" : "days"}
          </CardTitle>
          <p className="mt-1 text-xs text-ink-muted">
            Credential entries, IST — <strong>not visits</strong>. Supabase
            refresh tokens keep a session alive for days, so somebody who signed
            in on Monday works all week without appearing again. Expect this to
            read far lower than the number of people using the CRM.
          </p>
        </CardHeader>
        <CardContent>
          <UsageBarChart
            points={view.login_trend.map((d) => ({
              key: d.day,
              value: d.logins,
              tooltip: `${d.day} — ${formatCount(d.logins)} logins by ${formatCount(d.people)} people`,
            }))}
            ariaLabel={`Logins per day over ${view.filters.days} days, peak ${peakLogins}`}
            startLabel={view.login_trend[0]?.day ?? ""}
            endLabel={view.login_trend[view.login_trend.length - 1]?.day ?? ""}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="space-y-3">
          <div>
            <CardTitle className="text-base">Login history</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Who signed in and when. Deleted after 90 days.
            </p>
          </div>
          <UsageFilterBar filters={view.filters} people={people} />
        </CardHeader>
        <CardContent>
          {view.history.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No logins recorded in this window. If that is unexpected, check
              that <code>drizzle/E-214_usage_analytics.sql</code> has been
              applied — the write path swallows its own errors by design, so an
              unapplied migration shows up here as silence rather than as a
              failure.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    <th className="py-2 pr-3">When</th>
                    <th className="py-2 pr-3">Who</th>
                    <th className="py-2 pr-3">Role at the time</th>
                    <th className="py-2 text-right">Method</th>
                  </tr>
                </thead>
                <tbody>
                  {view.history.map((row) => (
                    <LoginRow key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
              {view.history_truncated && (
                // Never truncate silently: a capped list that looks complete is
                // how somebody concludes "nobody else signed in".
                <p className="mt-3 text-[11px] text-warning">
                  Showing the most recent {view.history.length} of more. Narrow
                  the window or pick a person to see the rest.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-center text-[11px] text-ink-muted">
        Aggregates collected by <code>usage.activity</code> every 15 min · login
        history read live from <code>user_login_events</code> · session duration
        arrives with the heartbeat
      </p>
    </div>
  );
}
