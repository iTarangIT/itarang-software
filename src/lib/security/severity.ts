/**
 * Severity vocabulary for the CRM security scanner.
 *
 * This is the pentest-standard ladder (critical → info), deliberately DISTINCT
 * from the NBFC risk engine's severity (`src/lib/risk/severity.ts`, which uses
 * high|warn|ok|inconclusive|error). The two features are unrelated — do not
 * import across them.
 *
 * Severity is always set by a deterministic probe rule, never by the language
 * model. A finding the probe could only suspect is downgraded via `confidence`
 * (possible/likely/confirmed), not by inflating severity.
 */
export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

/** Tailwind class bundles per severity (light + dark), mirroring the risk page's token shape. */
export const SEVERITY_COLOR_TOKENS: Record<
  Severity,
  { fg: string; bg: string; ring: string; bar: string; dot: string }
> = {
  critical: {
    fg: "text-red-700 dark:text-red-300",
    bg: "bg-red-50 dark:bg-red-950/40",
    ring: "ring-red-500/40",
    bar: "bg-red-600",
    dot: "bg-red-600",
  },
  high: {
    fg: "text-orange-600 dark:text-orange-400",
    bg: "bg-orange-50 dark:bg-orange-950/30",
    ring: "ring-orange-500/30",
    bar: "bg-orange-500",
    dot: "bg-orange-500",
  },
  medium: {
    fg: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-50 dark:bg-amber-950/30",
    ring: "ring-amber-500/30",
    bar: "bg-amber-500",
    dot: "bg-amber-500",
  },
  low: {
    fg: "text-sky-600 dark:text-sky-400",
    bg: "bg-sky-50 dark:bg-sky-950/30",
    ring: "ring-sky-500/30",
    bar: "bg-sky-500",
    dot: "bg-sky-500",
  },
  info: {
    fg: "text-slate-600 dark:text-slate-400",
    bg: "bg-slate-100 dark:bg-slate-800/60",
    ring: "ring-slate-400/30",
    bar: "bg-slate-400",
    dot: "bg-slate-400",
  },
};

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function severityRank(s: Severity): number {
  return RANK[s] ?? 99;
}

/** Sort helper: most severe first. */
export function compareSeverity(a: Severity, b: Severity): number {
  return severityRank(a) - severityRank(b);
}

export function isSeverity(x: unknown): x is Severity {
  return typeof x === "string" && (SEVERITIES as string[]).includes(x);
}

/** Tabs on the dashboard — the severity ladder plus an "all" pseudo-tab handled in the UI. */
export const TAB_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
