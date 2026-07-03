/**
 * Report emitters for the perf-audit harness: raw JSON plus a markdown summary
 * with per-role tables sorted by worst median LCP.
 */
import fs from "node:fs";
import path from "node:path";
import type { AuditRole, PageResult, RunReport, RunSample } from "./types";

function kb(bytes: number): string {
  return (bytes / 1024).toFixed(0);
}

function ms(v: number | null): string {
  return v === null ? "–" : `${Math.round(v)}`;
}

function sortKey(r: PageResult): number {
  // Worst-first: pages with no LCP (errored/hydration-only) sort by net-idle.
  return r.median?.lcpMs ?? r.median?.networkIdleMs ?? -1;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function errorSummary(m: RunSample): string {
  const parts: string[] = [];
  if (m.pageErrors.length) parts.push(`${m.pageErrors.length} js`);
  if (m.consoleErrors.length) parts.push(`${m.consoleErrors.length} console`);
  if (m.httpErrors.length) parts.push(`${m.httpErrors.length} http`);
  return parts.join(", ") || "–";
}

function tableFor(results: PageResult[]): string {
  const rows = results
    .filter((r) => r.status === "ok" && r.median)
    .sort((a, b) => sortKey(b) - sortKey(a));
  if (rows.length === 0) return "_no pages measured_\n";

  const lines = [
    "| URL | LCP ms | FCP ms | TTFB ms | net-idle ms | JS KB | total KB | reqs | worst API | errors |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  ];
  for (const r of rows) {
    const m = r.median as RunSample;
    const worstApi = m.slowestApiCalls[0]
      ? `${m.slowestApiCalls[0].url} (${m.slowestApiCalls[0].durationMs}ms)`
      : "–";
    lines.push(
      `| ${r.resolvedUrl} | ${ms(m.lcpMs)} | ${ms(m.fcpMs)} | ${ms(m.ttfbMs)} | ` +
        `${ms(m.networkIdleMs)} | ${kb(m.jsBytes)} | ${kb(m.transferBytes)} | ` +
        `${m.requestCount} | ${worstApi} | ${errorSummary(m)} |`,
    );
  }
  return lines.join("\n") + "\n";
}

export function writeReport(report: RunReport, outDir: string): { json: string; md: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "report.json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const ok = report.results.filter((r) => r.status === "ok" && r.median);
  const lcps = ok
    .map((r) => r.median?.lcpMs)
    .filter((v): v is number => typeof v === "number");
  const idles = ok.map((r) => r.median?.networkIdleMs ?? 0);

  const md: string[] = [
    "# CRM page-load audit",
    "",
    `- Base URL: ${report.baseUrl}`,
    `- Commit: ${report.commit}`,
    `- Started: ${report.startedAt} — finished: ${report.finishedAt}`,
    `- Runs per page: ${report.runsPerPage} (medians reported)`,
    `- Pages measured: ${ok.length}, errored: ${report.results.filter((r) => r.status === "error").length}, skipped: ${report.skipped.length}`,
    `- LCP p50/p95: ${ms(percentile(lcps, 50))} / ${ms(percentile(lcps, 95))} ms`,
    `- Network-idle p50/p95: ${ms(percentile(idles, 50))} / ${ms(percentile(idles, 95))} ms`,
    "",
    "## Top 10 slowest pages (median LCP, all roles)",
    "",
    tableFor([...ok].sort((a, b) => sortKey(b) - sortKey(a)).slice(0, 10)),
  ];

  for (const role of report.roles) {
    const roleResults = report.results.filter((r) => r.role === role);
    if (roleResults.length === 0) continue;
    md.push(`## Role: ${role}`, "", tableFor(roleResults));
    const errored = roleResults.filter((r) => r.status === "error");
    if (errored.length) {
      md.push("### Errored pages", "");
      for (const e of errored) md.push(`- \`${e.resolvedUrl}\` — ${e.error}`);
      md.push("");
    }
  }

  if (report.skipped.length) {
    md.push("## Skipped pages", "");
    for (const s of report.skipped) md.push(`- \`${s.url}\` (${s.role}) — ${s.reason}`);
    md.push("");
  }

  const mdPath = path.join(outDir, "report.md");
  fs.writeFileSync(mdPath, md.join("\n"));
  return { json: jsonPath, md: mdPath };
}

export function emptyReport(
  baseUrl: string,
  commit: string,
  runsPerPage: number,
  roles: AuditRole[],
): RunReport {
  return {
    baseUrl,
    commit,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    runsPerPage,
    roles,
    results: [],
    skipped: [],
  };
}
