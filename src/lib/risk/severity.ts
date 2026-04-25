/**
 * Severity helpers shared between hand-coded cards and the LangGraph workflow.
 */
import type { Severity } from "./hand-coded-cards";

export const SEVERITIES: Severity[] = ["high", "warn", "ok"];

export const SEVERITY_LABELS: Record<Severity, string> = {
  high: "High Alert",
  warn: "Warning",
  ok: "OK",
};

export const SEVERITY_COLOR_TOKENS: Record<Severity, { fg: string; bg: string; ring: string }> = {
  high: { fg: "text-red-600 dark:text-red-400", bg: "bg-red-50 dark:bg-red-950/30", ring: "ring-red-500/30" },
  warn: { fg: "text-amber-600 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950/30", ring: "ring-amber-500/30" },
  ok: { fg: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950/30", ring: "ring-emerald-500/30" },
};

export function severityRank(s: Severity): number {
  return s === "high" ? 0 : s === "warn" ? 1 : 2;
}
