import { formatIst } from "@/lib/operations/format";
import type { RatePoint } from "@/lib/operations/logs";

/**
 * Hourly error/warn volume as stacked bars.
 *
 * Bars rather than a line: the series is a count per bucket, and an hour with
 * no errors is a real, meaningful zero. A line interpolates straight through it
 * and hides the quiet period that tells you when the problem started.
 *
 * That argument only holds if the zeros actually arrive, and for a long time
 * they did not — getLogsView() emitted rows only for hours that HAD log lines,
 * so the baseline tick below was unreachable and three scattered hours in a
 * 14-day window drew as three evenly-spaced bars, reading as continuous
 * activity. The series is gap-filled in SQL now, so `points` is always
 * contiguous and hourly, and its length is the width of the window.
 *
 * Inline SVG for the same reason as MetricSparkline — no charting library on a
 * page whose job is to load while things are broken.
 */
export function LogRateChart({ points }: { points: RatePoint[] }) {
  // Now a FALLBACK, not a normal state: the gap-filled query always returns at
  // least two buckets, so an empty array means the caller failed rather than
  // that the window was quiet (a quiet window is a row of zeros). Keep it —
  // the points[0]! / points[length-1]! accesses below depend on it.
  if (points.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-ink-muted">
        No log lines in this window.
      </p>
    );
  }

  const max = Math.max(...points.map((p) => p.errors + p.warns), 1);
  // FIXED viewBox width, with the bars divided into it — not a width that grows
  // with the point count. The series is gap-filled now, so a 14-day window is
  // always 337 contiguous buckets; a `points.length * 14` width made the viewBox
  // 4718 units wide inside a 56-unit-tall box, and the default
  // preserveAspectRatio="xMidYMid meet" then scaled the whole drawing down to
  // fit — rendering the chart as a ~10px-tall smear. "none" stretches to the
  // container instead, which is what a bar strip wants.
  const width = 720;
  const height = 56;
  // Below ~120 bars a gap reads as separation; above it, it eats the bar.
  const gap = points.length > 120 ? 0 : 2;
  const slot = width / points.length;
  const barWidth = Math.max(slot - gap, 0.5);

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-14 w-full"
        role="img"
        aria-label={`Hourly error and warning volume over ${points.length} hours, peak ${max} per hour`}
      >
        {points.map((point, i) => {
          const total = point.errors + point.warns;
          const x = i * slot;
          const errorHeight = (point.errors / max) * height;
          const warnHeight = (point.warns / max) * height;

          return (
            <g key={point.at.toISOString()}>
              <title>
                {`${formatIst(point.at)} — ${point.errors} errors, ${point.warns} warnings`}
              </title>
              {/* Full-height transparent hit area, so hovering a near-zero bar
                  still surfaces its tooltip. */}
              <rect x={x} y={0} width={barWidth} height={height} fill="transparent" />
              <rect
                x={x}
                y={height - warnHeight}
                width={barWidth}
                height={warnHeight}
                className="fill-warning"
                opacity={0.55}
              />
              <rect
                x={x}
                y={height - warnHeight - errorHeight}
                width={barWidth}
                height={errorHeight}
                className="fill-danger"
              />
              {total === 0 && (
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
      <div className="mt-1 flex items-center justify-between text-[10px] text-ink-muted">
        <span>{formatIst(points[0]!.at)}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-danger" /> errors
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-warning opacity-55" />{" "}
            warnings
          </span>
          <span>peak {max}/h</span>
        </span>
        <span>{formatIst(points[points.length - 1]!.at)}</span>
      </div>
    </div>
  );
}
