/**
 * Severity + verdict-provenance vocabulary shared between the hand-coded cards,
 * the LangGraph workflow, and the Risk page.
 *
 * "ok" means we ran the test and it found nothing. It does NOT mean "we could
 * not run the test" — that is `inconclusive`, and a test that blew up is
 * `error`. Collapsing those three into "ok" is what made a broken engine render
 * as a healthy portfolio.
 */
export type Severity = "high" | "warn" | "ok" | "inconclusive" | "error";

/**
 * Where a card's severity/counts actually came from.
 *   hand_coded  — a TS evaluator in hand-coded-cards.ts did the arithmetic
 *   sandbox     — agent-authored Python, executed deterministically on real data
 *   none        — no verdict was computed (sandbox down, or agent emitted no code)
 *   legacy_llm  — pre-E-185 row; an LLM may have stated the numbers itself. Not trustworthy.
 */
export type VerdictSource = "hand_coded" | "sandbox" | "none" | "legacy_llm";

export const SEVERITIES: Severity[] = ["high", "warn", "ok", "inconclusive", "error"];

export const SEVERITY_LABELS: Record<Severity, string> = {
  high: "High Alert",
  warn: "Warning",
  ok: "OK",
  inconclusive: "Inconclusive",
  error: "Error",
};

export const SEVERITY_COLOR_TOKENS: Record<Severity, { fg: string; bg: string; ring: string; bar: string }> = {
  high: {
    fg: "text-red-600 dark:text-red-400",
    bg: "bg-red-50 dark:bg-red-950/30",
    ring: "ring-red-500/30",
    bar: "bg-red-500",
  },
  warn: {
    fg: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-50 dark:bg-amber-950/30",
    ring: "ring-amber-500/30",
    bar: "bg-amber-500",
  },
  ok: {
    fg: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
    ring: "ring-emerald-500/30",
    bar: "bg-emerald-500",
  },
  inconclusive: {
    fg: "text-slate-600 dark:text-slate-400",
    bg: "bg-slate-100 dark:bg-slate-800/60",
    ring: "ring-slate-400/30",
    bar: "bg-slate-400",
  },
  error: {
    fg: "text-violet-600 dark:text-violet-400",
    bg: "bg-violet-50 dark:bg-violet-950/30",
    ring: "ring-violet-500/30",
    bar: "bg-violet-500",
  },
};

export const VERDICT_SOURCE_LABELS: Record<VerdictSource, string> = {
  hand_coded: "Computed",
  sandbox: "Computed (sandbox)",
  none: "Not computed",
  legacy_llm: "Unverified (legacy)",
};

/** A card whose numbers nobody computed must not be read as a measurement. */
export function isComputed(source: VerdictSource | null | undefined): boolean {
  return source === "hand_coded" || source === "sandbox";
}

/**
 * `error` and `inconclusive` share the "Inconclusive" tab — from an operator's
 * point of view both mean "this hypothesis did not produce a verdict" — but they
 * stay distinct in the DB and on the card chip so we can tell a crash from a
 * missing sandbox.
 */
export type SeverityTab = "high" | "warn" | "inconclusive" | "ok";

export const TAB_ORDER: SeverityTab[] = ["high", "warn", "inconclusive", "ok"];

export const TAB_LABELS: Record<SeverityTab, string> = {
  high: "High Alert",
  warn: "Warning",
  inconclusive: "Inconclusive",
  ok: "OK",
};

export function tabFor(s: Severity): SeverityTab {
  return s === "error" ? "inconclusive" : s;
}

const RANK: Record<Severity, number> = { high: 0, warn: 1, error: 2, inconclusive: 3, ok: 4 };

export function severityRank(s: Severity): number {
  return RANK[s] ?? 99;
}
