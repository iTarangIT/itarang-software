import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatINR } from "@/lib/currency";
import {
  getElevenLabsView,
  type CategoryUsage,
  type MonthlyUsage,
  type RecentCall,
} from "@/lib/operations/elevenlabs";
import {
  formatCount,
  formatDuration,
  formatIst,
  formatMinutesAgo,
  minutesSince,
} from "@/lib/operations/format";
import { getMetric, severityFor, type Severity } from "@/lib/operations/registry";

import { AutoRefresh } from "../_components/AutoRefresh";
import { MetricSparkline } from "../_components/MetricSparkline";
import { UsageBarChart } from "../_components/UsageBarChart";

export const metadata = { title: "ElevenLabs · Ops Console" };

/**
 * ElevenLabs usage and credits.
 *
 * One question: is the sales team actually using ElevenLabs, and how much are
 * we consuming? Two halves answer it, and they come from different places on
 * purpose.
 *
 *   the vendor's numbers — credits, quota, tier, reset. Polled hourly by the
 *     `vendor.elevenlabs` collector; nothing else in the CRM watches these, so
 *     a burn-out is otherwise invisible until calls simply stop connecting.
 *   our numbers — calls, talk time and metered cost from ai_call_logs. This is
 *     the half that answers "is anyone actually using it", which a credit
 *     balance alone cannot: a flat balance and a flat call count look identical
 *     on a graph of credits, and mean opposite things.
 */

/** Same tones as MetricTile, so a threshold reads the same across the console. */
const TONE: Record<Severity, string> = {
  ok: "text-ink",
  warn: "text-warning",
  crit: "text-danger",
  // Explicitly not green — "we have no data" is not evidence of health.
  unknown: "text-ink-muted",
};

const BORDER: Record<Severity, string> = {
  ok: "border-border",
  warn: "border-warning/40 bg-warning-bg/40",
  crit: "border-danger/50 bg-danger-bg/40",
  unknown: "border-dashed border-border",
};

/**
 * One headline number.
 *
 * Local rather than the shared MetricTile: only two of these six numbers are
 * registry metrics with thresholds and a sparkline behind them, and mixing
 * MetricTile with a plainer tile in one row makes the row read as two rows.
 * operations/page.tsx inlines its own `Tile` for the same reason. The registry
 * thresholds are still honoured — see `severity` at the call sites below.
 */
function Tile({
  label,
  value,
  hint,
  severity = "ok",
  help,
}: {
  label: string;
  value: string;
  hint?: string;
  severity?: Severity;
  help?: string;
}) {
  return (
    <div className={`rounded-lg border p-3 ${BORDER[severity]}`} title={help}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${TONE[severity]}`}>
        {value}
      </div>
      {hint && <div className="mt-1 text-[10px] text-ink-muted">{hint}</div>}
    </div>
  );
}

/** Percentages with an explicit sign — a delta needs its direction. */
function delta(pct: number | null) {
  if (pct == null) return <span className="text-ink-muted">—</span>;
  const rounded = Math.round(pct * 10) / 10;
  const tone =
    rounded > 15 ? "text-danger" : rounded < -15 ? "text-success" : "text-ink-muted";
  return (
    <span className={`tabular-nums ${tone}`}>
      {rounded > 0 ? "+" : ""}
      {rounded}%
    </span>
  );
}

/** Monthly cost bars. Same shape as the burn chart on /operations/spend. */
function MonthChart({
  monthly,
  currentMonth,
}: {
  monthly: MonthlyUsage[];
  currentMonth: string;
}) {
  if (monthly.length === 0) {
    return <p className="text-sm text-ink-muted">No ElevenLabs calls on record.</p>;
  }
  // Oldest-to-newest reads left to right like every other time axis.
  const series = [...monthly].reverse();
  const max = Math.max(...series.map((m) => m.cost_paise), 1);

  return (
    <div className="flex items-end gap-2">
      {series.map((month) => {
        const partial = month.month === currentMonth;
        return (
          <div key={month.month} className="flex flex-1 flex-col items-center gap-1">
            <span className="text-[10px] tabular-nums text-ink-muted">
              {formatINR(month.cost_paise)}
            </span>
            <div
              className={`w-full rounded-t ${partial ? "bg-brand-sky/50" : "bg-brand-navy"}`}
              style={{ height: `${Math.max((month.cost_paise / max) * 80, 2)}px` }}
              title={
                `${month.month} — ${formatCount(month.calls)} calls, ` +
                `${formatINR(month.cost_paise)}` +
                (partial ? " (month in progress)" : "")
              }
            />
            <span className="text-[10px] text-ink-muted">{month.month.slice(2)}</span>
          </div>
        );
      })}
    </div>
  );
}

function CategoryRow({ row, totalCalls }: { row: CategoryUsage; totalCalls: number }) {
  const share = totalCalls > 0 ? (row.calls / totalCalls) * 100 : 0;

  return (
    <tr className="border-b border-border/60 align-top last:border-0">
      <td className="py-2.5 pr-3">
        <span className={row.is_campaign ? "font-medium text-ink" : "text-ink-muted"}>
          {row.category}
        </span>
        {!row.is_campaign && (
          <div className="mt-0.5 text-[11px] text-ink-muted">
            Dialled outside any campaign — counted here so the rows still sum to
            the 30-day total.
          </div>
        )}
      </td>
      <td className="py-2.5 pr-3 text-right tabular-nums text-ink">
        {formatCount(row.calls)}
      </td>
      <td className="py-2.5 pr-3 text-right tabular-nums text-ink-muted">
        {Math.round(share)}%
      </td>
      <td className="py-2.5 pr-3 text-right tabular-nums text-ink-muted">
        {formatDuration(row.duration_s)}
      </td>
      <td className="py-2.5 text-right tabular-nums text-ink">
        {formatINR(row.cost_paise)}
      </td>
    </tr>
  );
}

function RecentRow({ call }: { call: RecentCall }) {
  return (
    <tr className="border-b border-border/60 align-top last:border-0">
      <td className="py-2.5 pr-3 text-xs text-ink-muted">
        {formatIst(call.ended_at)}
      </td>
      <td className="py-2.5 pr-3">
        <div className="max-w-[16rem] truncate text-ink" title={call.campaign ?? undefined}>
          {call.campaign ?? <span className="text-ink-muted">outside campaign</span>}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-ink-muted" title={call.call_id}>
          {call.call_id}
        </div>
      </td>
      <td className="py-2.5 pr-3 text-xs tabular-nums text-ink-muted">
        {call.phone_masked ?? "—"}
      </td>
      <td className="py-2.5 pr-3 text-xs text-ink-muted">{call.status ?? "—"}</td>
      <td className="py-2.5 pr-3 text-right tabular-nums text-ink-muted">
        {formatDuration(call.duration_s)}
      </td>
      <td className="py-2.5 text-right tabular-nums text-ink">
        {call.cost_paise == null ? (
          <span className="text-ink-muted" title="Cost not fetched for this call yet">
            —
          </span>
        ) : (
          formatINR(call.cost_paise)
        )}
      </td>
    </tr>
  );
}

export default async function OperationsElevenLabsPage() {
  let view: Awaited<ReturnType<typeof getElevenLabsView>>;
  try {
    view = await getElevenLabsView();
  } catch (e) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-danger">
            ElevenLabs usage unavailable
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

  const { credits, mtd, total, thirty_day: thirty } = view;

  // Thresholds come from the registry, so a tile here goes amber at exactly the
  // value that opens a warn alert. Duplicating the numbers would let the two
  // drift and make an alert disagree with the page it links to.
  const remainingSeverity = severityFor(
    getMetric("vendor.credits_remaining")!,
    credits.remaining,
  );
  const quotaSeverity = severityFor(
    getMetric("vendor.credits_used_pct")!,
    credits.used_pct,
  );

  const noCredits = credits.remaining == null && credits.used_pct == null;
  const categoryCalls = view.by_category.reduce((sum, r) => sum + r.calls, 0);
  const costGap = mtd.calls - mtd.calls_with_cost;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-muted">
          Credits come from ElevenLabs; calls, talk time and cost come from{" "}
          <code>ai_call_logs</code>. A healthy balance with no calls means the
          team stopped using it — which is the reading a credit graph alone hides.
        </p>
        <AutoRefresh intervalMs={60_000} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile
          label="Credits remaining"
          value={credits.remaining == null ? "—" : `${formatCount(credits.remaining)} cr`}
          hint={credits.limit == null ? undefined : `of ${formatCount(credits.limit)} quota`}
          severity={remainingSeverity}
          help={getMetric("vendor.credits_remaining")?.help}
        />
        <Tile
          label="Quota used"
          value={credits.used_pct == null ? "—" : `${credits.used_pct}%`}
          hint={credits.reset_at ? `resets ${formatIst(credits.reset_at)}` : undefined}
          severity={quotaSeverity}
          help={getMetric("vendor.credits_used_pct")?.help}
        />
        <Tile
          label="Credits consumed"
          value={credits.used == null ? "—" : `${formatCount(credits.used)} cr`}
          hint="this billing period"
          help="Reported by ElevenLabs, not derived from our cost figures."
        />
        <Tile
          label="Calls (MTD)"
          value={formatCount(mtd.calls)}
          hint={`${formatCount(thirty.calls)} in last 30d`}
        />
        <Tile
          label="Cost (MTD)"
          value={formatINR(mtd.cost_paise)}
          hint={
            costGap > 0 ? `${formatCount(costGap)} calls missing cost` : "all calls costed"
          }
          help={
            costGap > 0
              ? "Some calls have no cost yet — the figure reads low until the backfill catches them."
              : undefined
          }
        />
        <Tile
          label="Talk time (MTD)"
          value={formatDuration(mtd.duration_s)}
          hint={`${formatDuration(thirty.duration_s)} in last 30d`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Daily usage (30 days)</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Calls per day, IST. Empty days are drawn as a baseline rather than
              skipped — a run of them is the signal this page exists for.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <UsageBarChart
              points={view.daily.map((d) => ({
                key: d.day,
                value: d.calls,
                tooltip: `${d.day} — ${formatCount(d.calls)} calls, ${formatINR(d.cost_paise)}`,
              }))}
              ariaLabel={`Daily ElevenLabs call volume over 30 days, peak ${Math.max(
                ...view.daily.map((d) => d.calls),
                0,
              )} per day`}
              startLabel={view.daily[0]?.day ?? ""}
              endLabel={view.daily[view.daily.length - 1]?.day ?? ""}
              footNote={`${formatCount(thirty.calls)} calls · ${formatINR(thirty.cost_paise)}`}
            />
            {thirty.calls === 0 && (
              <p className="text-[11px] text-warning">
                No ElevenLabs calls in the last 30 days. Either the dialer is idle
                or calls are going through another provider.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Credits &amp; quota</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Polled hourly from ElevenLabs. Read the percentage with the reset
              date — 90% on the last day of the period is fine.
            </p>
          </CardHeader>
          <CardContent>
            {noCredits ? (
              <p className="text-sm text-ink-muted">
                No credit data yet. The <code>vendor.elevenlabs</code> collector
                needs <code>ELEVENLABS_API_KEY</code> set; without it the collector
                returns nothing rather than failing.
              </p>
            ) : (
              <div className="space-y-3">
                <div className="h-1.5 overflow-hidden rounded-full bg-bg">
                  <div
                    className={
                      quotaSeverity === "crit"
                        ? "h-full bg-danger"
                        : quotaSeverity === "warn"
                          ? "h-full bg-warning"
                          : "h-full bg-success"
                    }
                    style={{ width: `${Math.min(credits.used_pct ?? 0, 100)}%` }}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-muted">
                  <span>{credits.used_pct ?? 0}% of quota used</span>
                  {credits.tier && <span>tier {credits.tier}</span>}
                  {credits.status && <span>status {credits.status}</span>}
                  {credits.reset_at && <span>resets {formatIst(credits.reset_at)}</span>}
                  <span className="ml-auto tabular-nums">
                    {formatMinutesAgo(credits.age_minutes)}
                  </span>
                </div>
                {view.credits_series.length >= 2 && (
                  <div>
                    <div className={`${TONE[remainingSeverity]} opacity-60`}>
                      <MetricSparkline points={view.credits_series} className="h-8 w-full" />
                    </div>
                    <p className="mt-1 text-[10px] text-ink-muted">
                      Credits remaining, last 7 days
                    </p>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Month over month</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Metered cost per calendar month, IST. The last bar is the month in
              progress.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <MonthChart monthly={view.monthly} currentMonth={view.current_month} />
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <span className="text-ink-muted">
                MoM (complete months) {delta(view.mom_delta_pct)}
              </span>
              <span className="text-ink-muted">
                All time{" "}
                <span className="font-semibold text-ink">
                  {formatINR(total.cost_paise)}
                </span>{" "}
                · {formatCount(total.calls)} calls ·{" "}
                {formatDuration(total.duration_s)}
              </span>
              {view.first_call_at && (
                <span className="text-ink-muted">
                  since {formatIst(view.first_call_at)}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Usage by campaign category</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Last 30 days. Calls are attributed through the dialer campaign that
              placed them; everything else lands in one explicit bucket rather
              than being dropped.
            </p>
          </CardHeader>
          <CardContent>
            {view.by_category.length === 0 ? (
              <p className="text-sm text-ink-muted">
                No ElevenLabs calls in the last 30 days.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      <th className="py-2 pr-3">Category</th>
                      <th className="py-2 pr-3 text-right">Calls</th>
                      <th className="py-2 pr-3 text-right">Share</th>
                      <th className="py-2 pr-3 text-right">Talk time</th>
                      <th className="py-2 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.by_category.map((row) => (
                      <CategoryRow
                        key={row.category}
                        row={row}
                        totalCalls={categoryCalls}
                      />
                    ))}
                  </tbody>
                </table>
                {categoryCalls !== thirty.calls && (
                  // These two are computed by different queries over the same
                  // window and must agree. If they ever do not, the attribution
                  // join has started dropping or duplicating rows — say so
                  // rather than quietly showing a breakdown that does not add up.
                  <p className="mt-3 text-[11px] text-warning">
                    Breakdown totals {formatCount(categoryCalls)} calls but the
                    30-day total is {formatCount(thirty.calls)} — the campaign
                    attribution join is losing or duplicating rows.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Recent calls</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              The last 20 completed ElevenLabs calls, campaign or not. Numbers are
              masked — this console is for operations, not sales.
            </p>
          </div>
          <Badge variant="muted">
            30d {formatINR(thirty.cost_paise)} · {formatCount(thirty.calls)} calls
          </Badge>
        </CardHeader>
        <CardContent>
          {view.recent.length === 0 ? (
            <p className="text-sm text-ink-muted">No ElevenLabs calls on record.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    <th className="py-2 pr-3">Ended</th>
                    <th className="py-2 pr-3">Campaign</th>
                    <th className="py-2 pr-3">Phone</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3 text-right">Duration</th>
                    <th className="py-2 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {view.recent.map((call) => (
                    <RecentRow key={call.call_id} call={call} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-center text-[11px] text-ink-muted">
        Credits polled by <code>{view.collector?.collector_id ?? "vendor.elevenlabs"}</code>
        {view.collector?.status === "failed" && (
          <span className="font-semibold text-danger">
            {" "}
            — last run failed: {view.collector.error}
          </span>
        )}
        {" · last run "}
        {view.collector?.last_run_at
          ? `${formatMinutesAgo(minutesSince(view.collector.last_run_at))} (${formatIst(
              view.collector.last_run_at,
            )})`
          : "never"}
        {view.last_updated && ` · sampled ${formatIst(view.last_updated, { withSeconds: true })}`}
        {" · call data read live from ai_call_logs"}
      </p>
    </div>
  );
}
