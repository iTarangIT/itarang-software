import { formatMetricValue, formatMinutesAgo } from "@/lib/operations/format";
import type { Severity } from "@/lib/operations/registry";
import type { MetricReading } from "@/lib/operations/views";

import { MetricSparkline } from "./MetricSparkline";

/**
 * One monitored number, with its trend and its threshold colour.
 *
 * The `help` text is on the tile itself (as a title tooltip) rather than in a
 * runbook: the person reading this at 2am needs "what does this mean and what
 * do I do when it goes red" at the point of the number, not a link away.
 */

const TONE: Record<Severity, { border: string; value: string; label: string }> = {
  ok: {
    border: "border-border",
    value: "text-ink",
    label: "",
  },
  warn: {
    border: "border-warning/40 bg-warning-bg/40",
    value: "text-warning",
    label: "Warn",
  },
  crit: {
    border: "border-danger/50 bg-danger-bg/40",
    value: "text-danger",
    label: "Critical",
  },
  // No value, or no threshold to judge it against. Explicitly not green —
  // green is a claim, and "we have no data" is not evidence of health.
  unknown: {
    border: "border-dashed border-border",
    value: "text-ink-muted",
    label: "No data",
  },
};

/** Minutes after which a reading is old enough that the age belongs on screen. */
const STALE_AFTER_MINUTES = 15;

export function MetricTile({ metric }: { metric: MetricReading }) {
  const tone = TONE[metric.severity];
  const stale =
    metric.age_minutes != null && metric.age_minutes > STALE_AFTER_MINUTES;

  const threshold =
    metric.crit != null
      ? `crit ${formatMetricValue(metric.crit, metric.unit)}`
      : metric.warn != null
        ? `warn ${formatMetricValue(metric.warn, metric.unit)}`
        : null;

  return (
    <div
      className={`rounded-lg border p-3 ${tone.border}`}
      title={metric.help}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
          {metric.label}
        </span>
        {tone.label && (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            {tone.label}
          </span>
        )}
      </div>

      <div className={`mt-1 text-xl font-semibold tabular-nums ${tone.value}`}>
        {metric.value == null
          ? "—"
          : formatMetricValue(metric.value, metric.unit)}
      </div>

      {metric.text && metric.value == null && (
        <div className="mt-0.5 truncate text-[11px] text-ink-muted" title={metric.text}>
          {metric.text}
        </div>
      )}

      <div className={`mt-2 ${tone.value} opacity-60`}>
        <MetricSparkline points={metric.series} />
      </div>

      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-ink-muted">
        <span>{threshold ?? ""}</span>
        {/* Only shown once the number is old enough to mislead. A timestamp on
            every fresh tile is noise that trains people to stop reading it. */}
        {stale && (
          <span className="tabular-nums">
            {formatMinutesAgo(metric.age_minutes)}
          </span>
        )}
      </div>
    </div>
  );
}
