import Link from "next/link";
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

/**
 * Preserve the active filters when toggling the module drill-down.
 *
 * Same shape as queryFor() on the logs page, and for the same reason: a
 * drill-down link that dropped the window would quietly move the user to a
 * different period than the row they just clicked was measured over.
 */
function queryWithModule(
  filters: { days: number; user?: string },
  module: string | null,
) {
  const params = new URLSearchParams();
  params.set("days", String(filters.days));
  if (filters.user) params.set("user", filters.user);
  if (module) params.set("module", module);
  return params.toString();
}

/**
 * The per-module drill-down.
 *
 * Two sources, kept visibly separate because they answer different questions and
 * have different retention:
 *
 *   module_usage_daily      (E-215) — aggregate, permanent, names nobody.
 *   module_usage_user_daily (E-216) — per person, pruned at 30 days, audited.
 *
 * The People section only ever shows what E-216 actually recorded. It must never
 * infer a person from a session: module_visit_keys resolves to a session's OWNER,
 * which was wrong for every row tested on live data. A missing name here is a
 * true "not recorded", and the section says so rather than guessing.
 *
 * Rendered as a sibling Card below the table rather than an expanded row: the
 * table already scrolls horizontally on narrow screens, and a nested table
 * inside a <td> would inherit that scroll container.
 */
function ModuleDetailCard({ view }: { view: Awaited<ReturnType<typeof getUsageView>> }) {
  const detail = view.module_detail;
  if (!detail) return null;

  const { detail: d, unavailable } = detail;
  const clearHref = `/operations/usage?${queryWithModule(view.filters, null)}`;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">
              {d.label} · day by day
            </CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Totals for this module over the last {view.filters.days}{" "}
              {view.filters.days === 1 ? "day" : "days"}. Time is derived from
              5-minute heartbeats, so read it as share of attention rather than
              as a timesheet.
            </p>
          </div>
          <Link
            href={clearHref}
            scroll={false}
            className="whitespace-nowrap rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-ink-muted hover:bg-brand-50"
          >
            Clear
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {unavailable ? (
          <p className="text-sm text-ink-muted">
            Module detail unavailable — most likely{" "}
            <code>drizzle/E-215_module_usage.sql</code> has not been applied to
            this database. The rest of this page is unaffected.
          </p>
        ) : d.empty ? (
          <p className="text-sm text-ink-muted">
            No activity recorded for {d.label} in this window. Nothing is wrong
            with the drill-down — the module simply has no rows in these{" "}
            {view.filters.days} {view.filters.days === 1 ? "day" : "days"}.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-xl border border-border bg-surface p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                  Sessions
                </p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
                  {formatCount(d.sessions)}
                </p>
                <p className="mt-1 text-[10px] text-ink-muted">
                  {formatCount(d.internal_sessions)} internal ·{" "}
                  {formatCount(d.external_sessions)} external
                </p>
              </div>
              <div
                className="rounded-xl border border-border bg-surface p-3"
                title="Derived from 5-minute heartbeats, so treat it as share of attention rather than a timesheet."
              >
                <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                  Time in module
                </p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
                  {formatMetricValue(d.minutes, "minutes")}
                </p>
                <p className="mt-1 text-[10px] text-ink-muted">
                  {formatCount(d.pings)} heartbeats
                </p>
              </div>
              <div className="rounded-xl border border-border bg-surface p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                  Last activity
                </p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
                  {d.last_day ?? "—"}
                </p>
                {/* Day granularity is a property of the table, not a shortcut
                    here — module_usage_daily stores no finer timestamp. */}
                <p className="mt-1 text-[10px] text-ink-muted">
                  IST, day precision
                </p>
              </div>
              <div className="rounded-xl border border-border bg-surface p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                  Days active
                </p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
                  {formatCount(d.days.length)}
                </p>
                <p className="mt-1 text-[10px] text-ink-muted">
                  since {d.first_day ?? "—"}
                </p>
              </div>
            </div>

            <UsageBarChart
              points={d.days.map((p) => ({
                key: p.day,
                value: p.pings,
                tooltip: `${p.day} — ${formatMetricValue(p.minutes, "minutes")} across ${formatCount(p.sessions)} sessions`,
              }))}
              ariaLabel={`${d.label} heartbeats per day over ${view.filters.days} days`}
              startLabel={d.first_day ?? ""}
              endLabel={d.last_day ?? ""}
              footNote="Only days with recorded activity appear."
            />

            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
                    <th className="pb-2 pr-3 font-medium">Day (IST)</th>
                    <th className="pb-2 pr-3 text-right font-medium">Sessions</th>
                    <th className="pb-2 pr-3 text-right font-medium">Internal</th>
                    <th className="pb-2 pr-3 text-right font-medium">External</th>
                    <th className="pb-2 text-right font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Newest first here, while the chart runs oldest-to-newest:
                      a reader scanning a table wants today at the top, and a
                      reader scanning a time axis wants it to run forwards. */}
                  {[...d.days].reverse().map((p) => (
                    <tr
                      key={p.day}
                      className="border-b border-border/60 last:border-0"
                    >
                      <td className="py-2.5 pr-3 tabular-nums text-ink">
                        {p.day}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-ink">
                        {formatCount(p.sessions)}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-ink-muted">
                        {p.internal_sessions === 0
                          ? "—"
                          : formatCount(p.internal_sessions)}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-ink-muted">
                        {p.external_sessions === 0
                          ? "—"
                          : formatCount(p.external_sessions)}
                      </td>
                      <td className="py-2.5 text-right tabular-nums text-ink-muted">
                        {formatMetricValue(p.minutes, "minutes")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ModulePeople view={view} label={d.label} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Who used this module (E-216).
 *
 * Separated from the aggregate above by a rule and a heading, because the two
 * carry different promises: everything above names nobody and is kept forever,
 * everything here names somebody and is deleted after 30 days. Collapsing them
 * into one table would blur exactly the distinction the reader needs to make.
 */
function ModulePeople({
  view,
  label,
}: {
  view: Awaited<ReturnType<typeof getUsageView>>;
  label: string;
}) {
  const users = view.module_users;
  if (!users) return null;

  return (
    <div className="space-y-2 border-t border-border pt-4">
      <div>
        <p className="text-sm font-semibold text-ink">People in {label}</p>
        <p className="mt-1 text-xs text-ink-muted">
          Recorded per person from the 5-minute heartbeat and{" "}
          <strong>deleted after 30 days</strong>. Opening this view is itself
          audited. Shows the account, the role it held at the time, and how much
          — never which records were opened, searched or edited.
        </p>
      </div>

      {users.unavailable ? (
        <p className="text-sm text-ink-muted">
          Per-person attribution unavailable — most likely{" "}
          <code>drizzle/E-216_module_usage_user_daily.sql</code> has not been
          applied to this database. The aggregate figures above are unaffected.
        </p>
      ) : users.rows.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No per-person rows for {label} in this window. Attribution only exists
          for activity recorded <strong>after E-216 was applied</strong> — the
          user-to-module link was never stored before that, so earlier usage
          stays aggregate and cannot be reconstructed.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="pb-2 pr-3 font-medium">Person</th>
                <th className="pb-2 pr-3 font-medium">Role at the time</th>
                <th className="pb-2 pr-3 font-medium">Type</th>
                <th className="pb-2 pr-3 text-right font-medium">Sessions</th>
                <th className="pb-2 pr-3 text-right font-medium">Time</th>
                <th className="pb-2 pr-3 text-right font-medium">Days</th>
                <th className="pb-2 text-right font-medium">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {users.rows.map((u) => (
                <tr
                  key={u.user_id}
                  className="border-b border-border/60 last:border-0"
                >
                  <td className="py-2.5 pr-3 text-ink">{u.name}</td>
                  <td className="py-2.5 pr-3">
                    <Badge variant="muted">{u.role}</Badge>
                  </td>
                  <td className="py-2.5 pr-3 text-ink-muted">
                    {u.bucket === "external" ? "External" : "Internal"}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums text-ink">
                    {formatCount(u.sessions)}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums text-ink-muted">
                    {formatMetricValue(u.minutes, "minutes")}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums text-ink-muted">
                    {formatCount(u.days_active)}
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-ink-muted">
                    {u.last_day ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

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
      // E-216. Opening a module's drill-down exposes who was in it, so the
      // module is part of what was looked at and belongs on the audit row.
      module: filters.module ?? null,
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
            Also records <strong>which module</strong> someone was in — one of
            six names such as <code>nbfc</code> or <code>asm</code> — both as a
            company-wide daily total <strong>and, since E-216, per person</strong>.
            The per-person record is a daily count of 5-minute heartbeats plus the
            role held at the time; it is <strong>deleted after 30 days</strong>,
            only the company-wide totals are kept beyond that, and reading it is
            audited. It covers external dealer and NBFC-partner accounts as well
            as staff.
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
          {/* Reports the FLAG, not an inference from an empty table. "No rows"
              and "switched off" are different diagnoses and used to render
              identically — see UsageView.heartbeat_enabled. */}
          <p className="mt-1 text-[10px] text-ink-muted">
            {view.sessions.count > 0
              ? `${formatCount(view.sessions.people)} people`
              : view.heartbeat_enabled
                ? "recording — no sessions in this window yet"
                : "session tracking is OFF (USAGE_HEARTBEAT)"}
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
        <CardHeader>
          <CardTitle className="text-base">
            Module usage · last {view.filters.days}{" "}
            {view.filters.days === 1 ? "day" : "days"}
          </CardTitle>
          <p className="mt-1 text-xs text-ink-muted">
            Which parts of the CRM are being used.{" "}
            <strong>Company-wide totals</strong> — this table has no user id
            behind it, so unlike everything else on this page it does{" "}
            <strong>not</strong> narrow when you filter to one person. Time is
            derived from 5-minute heartbeats, so treat it as share of attention
            rather than as a timesheet.
          </p>
        </CardHeader>
        <CardContent>
          {view.modules.unavailable ? (
            <p className="text-sm text-ink-muted">
              Module usage unavailable — most likely{" "}
              <code>drizzle/E-215_module_usage.sql</code> has not been applied to
              this database. The rest of this page is unaffected.
            </p>
          ) : (
            <>
              {view.modules.empty && (
                <p className="mb-3 text-sm text-ink-muted">
                  {view.heartbeat_enabled ? (
                    <>
                      No module data in this window yet. Recording <strong>is</strong>{" "}
                      on, so this means nobody has opened a tracked module in{" "}
                      {view.filters.days}{" "}
                      {view.filters.days === 1 ? "day" : "days"}. A ping is
                      attributed on the 5-minute heartbeat, so a brief visit may
                      not register — and this console itself is deliberately not
                      tracked.
                    </>
                  ) : (
                    <>
                      Module usage is <strong>not being recorded</strong>:{" "}
                      <code>USAGE_HEARTBEAT</code> is not set to <code>1</code>.
                      The browser timer needs{" "}
                      <code>NEXT_PUBLIC_USAGE_HEARTBEAT=1</code> as well, which is
                      compiled in and so requires a restart.
                    </>
                  )}
                </p>
              )}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-ink-muted">
                      <th className="pb-2 pr-3 font-medium">Module</th>
                      <th className="pb-2 pr-3 text-right font-medium">
                        Sessions
                      </th>
                      <th className="pb-2 pr-3 text-right font-medium">
                        Internal
                      </th>
                      <th className="pb-2 pr-3 text-right font-medium">
                        External
                      </th>
                      <th className="pb-2 pr-3 text-right font-medium">Time</th>
                      <th className="pb-2 font-medium">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.modules.rows.map((m) => {
                      const active = view.filters.module === m.module;
                      return (
                        <tr
                          key={m.module}
                          className={`border-b border-border/60 last:border-0 ${
                            active ? "bg-brand-50/60" : ""
                          }`}
                        >
                          <td className="py-2.5 pr-3 text-ink">
                            {/* The whole row's identity is its name, so the name
                                is the control — no extra "view" column to widen
                                a table that already scrolls on narrow screens. */}
                            <Link
                              href={`/operations/usage?${queryWithModule(
                                view.filters,
                                active ? null : m.module,
                              )}`}
                              scroll={false}
                              aria-current={active ? "true" : undefined}
                              className="font-medium underline-offset-2 hover:text-brand-700 hover:underline"
                            >
                              {m.label}
                            </Link>
                            {/* A module nobody has opened is the most useful
                                reading on this table, so it is called out rather
                                than left as an unremarkable zero. */}
                            {m.never_seen && (
                              <span className="ml-2 text-[10px] uppercase tracking-wide text-ink-muted">
                                no data
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 pr-3 text-right tabular-nums text-ink">
                            {m.sessions === 0 ? "—" : formatCount(m.sessions)}
                          </td>
                          <td className="py-2.5 pr-3 text-right tabular-nums text-ink-muted">
                            {m.internal_sessions === 0
                              ? "—"
                              : formatCount(m.internal_sessions)}
                          </td>
                          <td className="py-2.5 pr-3 text-right tabular-nums text-ink-muted">
                            {m.external_sessions === 0
                              ? "—"
                              : formatCount(m.external_sessions)}
                          </td>
                          <td className="py-2.5 pr-3 text-right tabular-nums text-ink-muted">
                            {m.pings === 0
                              ? "—"
                              : formatMetricValue(m.minutes, "minutes")}
                          </td>
                          <td className="py-2.5">
                            <div className="flex items-center gap-2">
                              <div
                                className="h-1.5 w-24 overflow-hidden rounded-full bg-border"
                                aria-hidden="true"
                              >
                                <div
                                  className="h-full rounded-full bg-brand-navy"
                                  style={{
                                    width: `${Math.round(m.share * 100)}%`,
                                  }}
                                />
                              </div>
                              <span className="text-xs tabular-nums text-ink-muted">
                                {m.pings === 0
                                  ? "—"
                                  : `${Math.round(m.share * 100)}%`}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {view.module_detail && <ModuleDetailCard view={view} />}

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
