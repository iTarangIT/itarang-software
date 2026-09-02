import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatDuration,
  formatIst,
  formatMetricValue,
  formatMinutesAgo,
} from "@/lib/operations/format";
import { getBoardView, type BoardTile } from "@/lib/operations/board";
import type { Severity } from "@/lib/operations/registry";

import { AutoRefresh } from "./_components/AutoRefresh";

export const metadata = { title: "Ops Console" };

/**
 * The one-slide board.
 *
 * Every monitored number worth glancing at, on one screen, designed to be
 * screenshotted for standup. Worst tiles sort first — a board you have to scan
 * to find the red one has failed at its only job.
 *
 * The freshness footer is not decoration. If the collectors stopped an hour
 * ago, every green tile above it is a historical curiosity, and the footer is
 * the only thing on the page that can tell you that.
 */

const TONE: Record<Severity, string> = {
  crit: "border-danger/50 bg-danger-bg/40",
  warn: "border-warning/40 bg-warning-bg/40",
  ok: "border-border",
  unknown: "border-dashed border-border",
};

const VALUE_TONE: Record<Severity, string> = {
  crit: "text-danger",
  warn: "text-warning",
  ok: "text-ink",
  unknown: "text-ink-muted",
};

/** Strip the "host:"/"dep:"/"rds:" prefix — the tile label already has context. */
function shortSource(source: string): string {
  return source.replace(/^(host|dep|rds|proc|job|vendor|provider|spend|logs|business|team):/, "");
}

function Tile({ tile }: { tile: BoardTile }) {
  const delta =
    tile.value != null && tile.yesterday != null ? tile.value - tile.yesterday : null;

  return (
    <div className={`rounded-lg border p-3 ${TONE[tile.severity]}`} title={tile.help}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[11px] font-medium uppercase tracking-wide text-ink-muted">
          {tile.label}
        </span>
        <span className="shrink-0 text-[10px] text-ink-muted">
          {shortSource(tile.source)}
        </span>
      </div>

      <div className={`mt-1 text-2xl font-semibold tabular-nums ${VALUE_TONE[tile.severity]}`}>
        {tile.value == null ? "—" : formatMetricValue(tile.value, tile.unit)}
      </div>

      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-ink-muted">
        {tile.yesterday == null ? (
          <span>no snapshot</span>
        ) : (
          <span className="tabular-nums">
            yday {formatMetricValue(tile.yesterday, tile.unit)}
            {delta != null && delta !== 0 && (
              <span className={delta > 0 ? " text-danger/70" : " text-success/70"}>
                {" "}
                {delta > 0 ? "▲" : "▼"}
              </span>
            )}
          </span>
        )}
        {tile.age_minutes != null && tile.age_minutes > 15 && (
          <span>{formatMinutesAgo(tile.age_minutes)}</span>
        )}
      </div>
    </div>
  );
}

export default async function OperationsBoardPage() {
  let view: Awaited<ReturnType<typeof getBoardView>>;
  try {
    view = await getBoardView();
  } catch (e) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-danger">Board unavailable</CardTitle>
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

  // The collectors run every 60s at most; twice that is a real stall.
  const stale =
    view.freshness.minutes_ago == null || view.freshness.minutes_ago > 5;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/operations/alerts">
          <Badge variant={view.alerts.crit > 0 ? "danger" : "muted"}>
            {view.alerts.crit} critical
          </Badge>
        </Link>
        <Link href="/operations/alerts">
          <Badge variant={view.alerts.warn > 0 ? "warning" : "muted"}>
            {view.alerts.warn} warning
          </Badge>
        </Link>
        {view.deploys.map((deploy) => (
          <Badge
            key={deploy.source}
            variant={view.deploy_mismatch ? "warning" : "outline"}
            title={`${deploy.source} — up ${formatDuration(deploy.uptime_s)}${deploy.node_env ? `, ${deploy.node_env}` : ""}`}
          >
            {shortSource(deploy.source)} @ {deploy.commit}
          </Badge>
        ))}
        {view.deploy_mismatch && (
          <Badge variant="warning">Environments on different builds</Badge>
        )}
        <div className="ml-auto">
          <AutoRefresh intervalMs={15_000} />
        </div>
      </div>

      {view.tiles.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No board metrics yet</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-ink-muted">
            Nothing flagged <code>onSlide</code> has reported in the last 24
            hours. Check <Link href="/operations/jobs" className="underline">
              /operations/jobs
            </Link>{" "}
            — if the collectors are not running, nothing else on this console is
            current either.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {view.tiles.map((tile) => (
            <Tile key={`${tile.key}|${tile.source}`} tile={tile} />
          ))}
        </div>
      )}

      {view.alerts.newest.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <CardTitle className="text-base">Open alerts</CardTitle>
            <Link
              href="/operations/alerts"
              className="text-xs font-semibold text-ink-muted underline"
            >
              All {view.alerts.total}
            </Link>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {view.alerts.newest.map((alert) => (
              <div
                key={`${alert.metric_key}|${alert.source}`}
                className="flex items-start gap-2 text-xs"
              >
                <Badge variant={alert.severity === "crit" ? "danger" : "warning"}>
                  {alert.severity}
                </Badge>
                <span className="flex-1 text-ink">{alert.message}</span>
                {alert.acknowledged && <Badge variant="muted">ack</Badge>}
                <span className="shrink-0 text-ink-muted">
                  {formatIst(alert.opened_at)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <p
        className={`text-center text-[11px] ${stale ? "font-semibold text-danger" : "text-ink-muted"}`}
      >
        Collectors last completed {formatMinutesAgo(view.freshness.minutes_ago)}
        {stale && " — every number above may be out of date"}
        {" · "}
        comparison against the {view.snapshot_date} snapshot
      </p>
    </div>
  );
}
