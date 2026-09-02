import type { SeriesPoint } from "@/lib/operations/samples";

/**
 * A 24-hour trend line, as inline SVG.
 *
 * Deliberately NOT the shared MetricsChart/recharts wrapper. There are up to
 * nine of these per host on the infrastructure page, they carry no axes, legend
 * or tooltip, and pulling a charting library into a page whose job is to load
 * when things are broken is the wrong trade. This is a path element.
 *
 * Renders nothing (not an empty box) below two points: one reading is not a
 * trend, and a flat line drawn through a single sample is a lie about history.
 */
export function MetricSparkline({
  points,
  className,
}: {
  points: SeriesPoint[];
  className?: string;
}) {
  const values = points
    .map((p) => p.value)
    .filter((v): v is number => v != null && Number.isFinite(v));

  if (values.length < 2) return null;

  const width = 100;
  const height = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A perfectly flat series would divide by zero; draw it down the middle.
  const span = max - min || 1;

  const step = width / (values.length - 1);
  const d = values
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / span) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className ?? "h-6 w-full"}
      role="img"
      aria-label={`24 hour trend, ${values.length} points, low ${min}, high ${max}`}
    >
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
