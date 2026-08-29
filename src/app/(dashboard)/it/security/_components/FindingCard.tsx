"use client";

import { SEVERITY_COLOR_TOKENS, SEVERITY_LABELS } from "@/lib/security/severity";
import { CATEGORY_LABELS } from "@/lib/security/types";
import type { FindingForUi } from "./SecurityFindings";

export default function FindingCard({
  finding,
  onOpen,
}: {
  finding: FindingForUi;
  onOpen: () => void;
}) {
  const tok = SEVERITY_COLOR_TOKENS[finding.severity];
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`text-left w-full rounded-xl border border-slate-200 dark:border-slate-800 ${tok.bg} p-4 ring-1 ${tok.ring} hover:shadow-md transition-shadow`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${tok.fg}`}>
          <span className={`h-2 w-2 rounded-full ${tok.dot}`} />
          {SEVERITY_LABELS[finding.severity]}
        </span>
        <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
          {CATEGORY_LABELS[finding.category]}
        </span>
        {finding.status === "resolved" ? (
          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Problem Resolved
          </span>
        ) : finding.status !== "open" ? (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 capitalize">
            {finding.status.replace("_", " ")}
          </span>
        ) : null}
      </div>

      <h3 className="mt-2 text-sm font-semibold text-slate-900 dark:text-slate-100 line-clamp-2">
        {finding.title}
      </h3>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 line-clamp-2">{finding.summary}</p>

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        {finding.http_method ? (
          <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600">
            {finding.http_method}
          </span>
        ) : null}
        <span className="text-[11px] font-mono text-slate-500 truncate max-w-[60%]" title={finding.target_url}>
          {shortUrl(finding.target_url)}
        </span>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-slate-400">
          {finding.confidence}
        </span>
      </div>

      {finding.owasp_ref || finding.cwe_ref ? (
        <div className="mt-2 flex gap-1.5">
          {finding.owasp_ref ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">
              {finding.owasp_ref}
            </span>
          ) : null}
          {finding.cwe_ref ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">
              {finding.cwe_ref}
            </span>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}

function shortUrl(u: string): string {
  try {
    const url = new URL(u);
    return url.pathname + (url.search ? url.search.slice(0, 24) : "");
  } catch {
    return u;
  }
}
