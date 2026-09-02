/**
 * A daily volume series as inline SVG bars.
 *
 * Bars rather than a line, for the same reason as LogRateChart: the series is a
 * count per day, and a day with no calls is a real, meaningful zero. On this
 * page that zero IS the signal — "the sales team stopped using ElevenLabs" is
 * exactly what a run of empty days means, and a line interpolated straight
 * through them would hide it.
 *
 * Inline SVG, not the shared recharts wrapper — same trade the rest of the Ops
 * Console makes. This is a rect element; a charting library on a page whose job
 * is to load while things are broken is the wrong dependency.
 */

export interface UsageBarPoint {
  /** Stable key, e.g. the YYYY-MM-DD day. */
  key: string;
  value: number;
  /** Hover text — the caller formats it, so this stays unit-agnostic. */
  tooltip: string;
}

export function UsageBarChart({
  points,
  ariaLabel,
  startLabel,
  endLabel,
  footNote,
}: {
  points: UsageBarPoint[];
  ariaLabel: string;
  startLabel: string;
  endLabel: string;
  footNote?: string;
}) {
  if (points.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-ink-muted">
        No calls in this window.
      </p>
    );
  }

  // max of 1 keeps an all-zero window from dividing by zero — it renders as a
  // flat row of baselines, which is the correct picture of "nothing happened".
  const max = Math.max(...points.map((p) => p.value), 1);
  const width = Math.max(points.length * 14, 120);
  const height = 56;
  const gap = 2;
  const barWidth = width / points.length - gap;

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-14 w-full min-w-[16rem]"
        role="img"
        aria-label={ariaLabel}
      >
        {points.map((point, i) => {
          const x = i * (barWidth + gap);
          const barHeight = (point.value / max) * height;

          return (
            <g key={point.key}>
              <title>{point.tooltip}</title>
              {/* Full-height transparent hit area, so hovering a near-zero bar
                  still surfaces its tooltip. */}
              <rect x={x} y={0} width={barWidth} height={height} fill="transparent" />
              {point.value > 0 ? (
                <rect
                  x={x}
                  y={height - barHeight}
                  width={barWidth}
                  height={barHeight}
                  className="fill-brand-navy"
                />
              ) : (
                // A visible baseline rather than nothing: an empty day must read
                // as "measured, and it was zero", not as missing data.
                <rect
                  x={x}
                  y={height - 1}
                  width={barWidth}
                  height={1}
                  className="fill-border"
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center justify-between gap-3 text-[10px] text-ink-muted">
        <span>{startLabel}</span>
        {footNote && <span>{footNote}</span>}
        <span>{endLabel}</span>
      </div>
    </div>
  );
}
