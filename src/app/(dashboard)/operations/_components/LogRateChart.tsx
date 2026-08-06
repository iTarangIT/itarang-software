import { formatIst } from "@/lib/operations/format";
import type { RatePoint } from "@/lib/operations/logs";

/**
 * Hourly error/warn volume as stacked bars.
 *
 * Bars rather than a line: the series is a count per bucket, and an hour with
 * no errors is a real, meaningful zero. A line interpolates straight through it
 * and hides the quiet period that tells you when the problem started.
 *
 * Inline SVG for the same reason as MetricSparkline — no charting library on a
 * page whose job is to load while things are broken.
 */
export function LogRateChart({ points }: { points: RatePoint[] }) {
  if (points.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-ink-muted">
        No log lines in this window.
      </p>
    );
  }

  const max = Math.max(...points.map((p) => p.errors + p.warns), 1);
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
        aria-label={`Hourly error and warning volume, peak ${max} per hour`}
      >
        {points.map((point, i) => {
          const total = point.errors + point.warns;
          const x = i * (barWidth + gap);
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
