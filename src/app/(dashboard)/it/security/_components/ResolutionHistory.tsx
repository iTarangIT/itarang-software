"use client";

/**
 * History tab UI — one card per resolved finding, and a drawer holding the full
 * resolution story: how it was resolved (AI auto-apply vs manual triage), the
 * diff that was written to source, and the append-only action timeline with the
 * actor and the ORIGIN IP of each action (security_finding_actions, E-219).
 *
 * The AI conversation is fetched lazily from the existing per-finding chat
 * endpoint when a card is opened — no reason to ship every transcript with the
 * page.
 */
import { useEffect, useMemo, useState } from "react";
import { SEVERITY_COLOR_TOKENS, SEVERITY_LABELS, severityRank, type Severity } from "@/lib/security/severity";
import { CATEGORY_LABELS, type SecurityCategory } from "@/lib/security/types";

export interface FindingActionForUi {
  id: string;
  action: string;
  method: string | null;
  actor_email: string | null;
  actor_role: string | null;
  ip: string | null;
  user_agent: string | null;
  summary: string | null;
  detail: Record<string, unknown> | null;
  created_at: string | null;
}

export interface ResolvedFindingForUi {
  id: string;
  check_slug: string;
  category: SecurityCategory;
  severity: Severity;
  title: string;
  summary: string;
  target_url: string;
  http_method: string | null;
  reproduction: string | null;
  remediation: string | null;
  evidence_json: Record<string, unknown> | null;
  owasp_ref: string | null;
  cwe_ref: string | null;
  confidence: string;
  status: string;
  created_at: string | null;
  resolved_at: string | null;
  resolution_method: string | null;
  resolution_summary: string | null;
  resolution_report: Record<string, unknown> | null;
  resolved_by_email: string | null;
  resolved_ip: string | null;
  resolved_user_agent: string | null;
  actions: FindingActionForUi[];
}

const ACTION_LABELS: Record<string, string> = {
  acknowledged: "Acknowledged",
  resolved: "Marked resolved",
  false_positive: "Marked false positive",
  reopened: "Reopened",
  auto_apply: "Fix auto-applied to source",
};

const ACTION_TONES: Record<string, { dot: string; fg: string }> = {
  auto_apply: { dot: "bg-emerald-500", fg: "text-emerald-700 dark:text-emerald-400" },
  resolved: { dot: "bg-sky-500", fg: "text-sky-700 dark:text-sky-400" },
  false_positive: { dot: "bg-amber-500", fg: "text-amber-700 dark:text-amber-400" },
  reopened: { dot: "bg-red-500", fg: "text-red-700 dark:text-red-400" },
  acknowledged: { dot: "bg-slate-400", fg: "text-slate-600 dark:text-slate-300" },
};

type MethodFilter = "all" | "auto_apply" | "manual" | "false_positive" | "reopened";

const METHOD_FILTERS: Array<{ value: MethodFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "auto_apply", label: "AI auto-applied" },
  { value: "manual", label: "Manual" },
  { value: "false_positive", label: "False positive" },
  { value: "reopened", label: "Reopened later" },
];

export default function ResolutionHistory({ findings }: { findings: ResolvedFindingForUi[] }) {
  const [open, setOpen] = useState<ResolvedFindingForUi | null>(null);
  const [q, setQ] = useState("");
  const [method, setMethod] = useState<MethodFilter>("all");

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return findings
      .filter((f) => {
        if (method === "auto_apply") return f.resolution_method === "auto_apply";
        if (method === "manual") return f.resolution_method === "manual" && f.status !== "false_positive";
        if (method === "false_positive") return f.status === "false_positive";
        if (method === "reopened") return f.status !== "resolved" && f.status !== "false_positive";
        return true;
      })
      .filter((f) => {
        if (!needle) return true;
        return (
          f.title.toLowerCase().includes(needle) ||
          f.target_url.toLowerCase().includes(needle) ||
          (f.resolved_by_email ?? "").toLowerCase().includes(needle) ||
          (f.resolved_ip ?? "").toLowerCase().includes(needle) ||
          (f.resolution_summary ?? "").toLowerCase().includes(needle) ||
          f.actions.some((a) => (a.ip ?? "").toLowerCase().includes(needle))
        );
      })
      .sort((a, b) => {
        const ta = a.resolved_at ? Date.parse(a.resolved_at) : 0;
        const tb = b.resolved_at ? Date.parse(b.resolved_at) : 0;
        if (tb !== ta) return tb - ta;
        return severityRank(a.severity) - severityRank(b.severity);
      });
  }, [findings, q, method]);

  if (findings.length === 0) {
    return (
      <div className="text-center text-sm text-slate-500 py-16 border border-dashed border-slate-300 dark:border-slate-700 rounded-lg">
        Nothing resolved yet. Resolve a finding from the Findings tab — via the AI resolution chat or
        the manual triage buttons — and it will appear here with its full audit trail.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {METHOD_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setMethod(f.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                method === f.value
                  ? "border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900"
                  : "border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search title, endpoint, resolver or IP…"
          className="text-sm px-3 py-2 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 w-full sm:w-80"
        />
      </div>

      {visible.length === 0 ? (
        <div className="text-center text-sm text-slate-500 py-12 border border-dashed border-slate-300 dark:border-slate-700 rounded-lg">
          No resolution records match the current filter.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((f) => (
            <HistoryCard key={f.id} finding={f} onOpen={() => setOpen(f)} />
          ))}
        </div>
      )}

      {open && <HistoryDrawer finding={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function HistoryCard({ finding, onOpen }: { finding: ResolvedFindingForUi; onOpen: () => void }) {
  const tok = SEVERITY_COLOR_TOKENS[finding.severity];
  const isFalsePositive = finding.status === "false_positive";
  const isReopened = finding.status !== "resolved" && !isFalsePositive;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-4 hover:shadow-md transition-shadow"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${tok.fg}`}>
          <span className={`h-2 w-2 rounded-full ${tok.dot}`} />
          {SEVERITY_LABELS[finding.severity]}
        </span>
        <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
          {CATEGORY_LABELS[finding.category]}
        </span>
        {isReopened ? (
          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-400 font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" /> Reopened
          </span>
        ) : isFalsePositive ? (
          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> False positive
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Resolved
          </span>
        )}
      </div>

      <h3 className="mt-2 text-sm font-semibold text-slate-900 dark:text-slate-100 line-clamp-2">
        {finding.title}
      </h3>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 line-clamp-2">
        {finding.resolution_summary || finding.summary}
      </p>

      <div className="mt-3 space-y-1 text-[11px] text-slate-500">
        <Row label="How">
          {finding.resolution_method === "auto_apply"
            ? "AI auto-applied a code fix"
            : finding.resolution_method === "manual"
              ? "Manual triage"
              : "—"}
        </Row>
        <Row label="By">{finding.resolved_by_email ?? "—"}</Row>
        <Row label="From IP">
          <code className="font-mono">{finding.resolved_ip ?? "unknown"}</code>
        </Row>
        <Row label="When">
          {finding.resolved_at ? new Date(finding.resolved_at).toLocaleString() : "—"}
        </Row>
      </div>

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
          {finding.actions.length} action{finding.actions.length === 1 ? "" : "s"}
        </span>
      </div>
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <span className="text-slate-400 shrink-0">{label}:</span>
      <span className="text-slate-600 dark:text-slate-300 truncate">{children}</span>
    </div>
  );
}

interface ChatMessage {
  id?: string;
  role: string;
  message: string;
  created_at?: string | null;
}

function HistoryDrawer({
  finding,
  onClose,
}: {
  finding: ResolvedFindingForUi;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadedChat, setLoadedChat] = useState(false);
  const tok = SEVERITY_COLOR_TOKENS[finding.severity];
  const report = (finding.resolution_report ?? {}) as Record<string, unknown>;
  const diff = typeof report.diff === "string" ? report.diff : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/it/security/findings/${finding.id}/chat`)
      .then((r) => r.json())
      .then((d) => {
        if (alive && d.ok) setMessages(d.messages ?? []);
      })
      .catch(() => {})
      .finally(() => alive && setLoadedChat(true));
    return () => {
      alive = false;
    };
  }, [finding.id]);

  return (
    <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose}>
      <div
        className="absolute right-0 top-0 bottom-0 w-full md:w-[680px] bg-white dark:bg-slate-950 shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 px-6 py-4 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${tok.fg}`}>
                <span className={`h-2 w-2 rounded-full ${tok.dot}`} />
                {SEVERITY_LABELS[finding.severity]}
              </span>
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                {CATEGORY_LABELS[finding.category]}
              </span>
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 capitalize">
                {finding.status.replace("_", " ")}
              </span>
            </div>
            <h2 className="mt-2 text-lg font-semibold text-slate-900 dark:text-slate-100">{finding.title}</h2>
            <code className="mt-1 block text-[11px] break-all text-slate-500">
              {finding.http_method ? `${finding.http_method} ` : ""}
              {finding.target_url}
            </code>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5 space-y-6 text-sm">
          {/* ---- How the system resolved it ---- */}
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 p-4">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-semibold text-sm">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              {finding.resolution_method === "auto_apply"
                ? "Resolved by AI auto-applied code fix"
                : finding.status === "false_positive"
                  ? "Closed as a false positive"
                  : "Resolved by manual triage"}
            </div>
            {finding.resolution_summary ? (
              <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">{finding.resolution_summary}</p>
            ) : null}
            <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <Field label="Method">
                {finding.resolution_method === "auto_apply"
                  ? "auto_apply (patched on disk)"
                  : (finding.resolution_method ?? "—")}
              </Field>
              <Field label="Resolved by">{finding.resolved_by_email ?? "—"}</Field>
              <Field label="From IP">
                <code className="font-mono">{finding.resolved_ip ?? "unknown"}</code>
              </Field>
              <Field label="Resolved at">
                {finding.resolved_at ? new Date(finding.resolved_at).toLocaleString() : "—"}
              </Field>
              {typeof report.file === "string" ? (
                <Field label="File changed">
                  <code className="font-mono break-all">{report.file}</code>
                </Field>
              ) : null}
              {typeof report.backup_path === "string" ? (
                <Field label="Backup">
                  <code className="font-mono break-all">{report.backup_path}</code>
                </Field>
              ) : null}
              {report.verified === true ? <Field label="Post-write verify">passed</Field> : null}
              {finding.resolved_user_agent ? (
                <Field label="User agent">
                  <span className="break-all">{finding.resolved_user_agent}</span>
                </Field>
              ) : null}
            </dl>
            {diff ? <DiffBlock diff={diff} /> : null}
          </div>

          {/* ---- Audit timeline ---- */}
          <div>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
              Resolution history
            </h4>
            {finding.actions.length === 0 ? (
              <p className="text-xs text-slate-500">
                No audit rows for this finding — it was resolved before the audit trail (E-219) was
                added. The resolution details above come from the stored report.
              </p>
            ) : (
              <ol className="relative border-l border-slate-200 dark:border-slate-800 ml-2 space-y-4">
                {finding.actions
                  .slice()
                  .reverse()
                  .map((a) => {
                    const tone = ACTION_TONES[a.action] ?? ACTION_TONES.acknowledged;
                    return (
                      <li key={a.id} className="ml-4">
                        <span
                          className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${tone.dot}`}
                        />
                        <div className={`text-xs font-semibold ${tone.fg}`}>
                          {ACTION_LABELS[a.action] ?? a.action}
                          {a.method ? (
                            <span className="ml-1.5 font-normal text-slate-400">via {a.method}</span>
                          ) : null}
                        </div>
                        {a.summary ? (
                          <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">{a.summary}</p>
                        ) : null}
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                          <span>
                            {a.created_at ? new Date(a.created_at).toLocaleString() : "unknown time"}
                          </span>
                          <span>
                            by {a.actor_email ?? "unknown"}
                            {a.actor_role ? ` (${a.actor_role})` : ""}
                          </span>
                          <span>
                            from IP <code className="font-mono">{a.ip ?? "unknown"}</code>
                          </span>
                        </div>
                        {a.user_agent ? (
                          <p className="mt-0.5 text-[10px] text-slate-400 break-all">{a.user_agent}</p>
                        ) : null}
                        {a.detail && typeof a.detail.diff === "string" && a.action === "auto_apply" ? (
                          <details className="mt-1.5">
                            <summary className="text-[11px] text-slate-500 cursor-pointer">
                              View applied diff
                            </summary>
                            <DiffBlock diff={String(a.detail.diff)} />
                          </details>
                        ) : null}
                      </li>
                    );
                  })}
                <li className="ml-4">
                  <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-700" />
                  <div className="text-xs font-semibold text-slate-500">Finding detected by scanner</div>
                  <div className="mt-1 text-[11px] text-slate-500">
                    {finding.created_at ? new Date(finding.created_at).toLocaleString() : "unknown time"} ·
                    check {finding.check_slug} · confidence {finding.confidence}
                  </div>
                </li>
              </ol>
            )}
          </div>

          {/* ---- The AI conversation that led to the fix ---- */}
          <div>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
              Resolution conversation
            </h4>
            {!loadedChat ? (
              <p className="text-xs text-slate-400">Loading…</p>
            ) : messages.length === 0 ? (
              <p className="text-xs text-slate-500">No conversation was recorded for this finding.</p>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800 p-3">
                {messages.map((m, i) => (
                  <Bubble key={m.id ?? i} role={m.role} text={m.message} />
                ))}
              </div>
            )}
          </div>

          {/* ---- The original vulnerability, for context ---- */}
          <details className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <summary className="text-xs font-medium text-slate-500 cursor-pointer">
              Original finding detail
            </summary>
            <div className="mt-3 space-y-3">
              <p className="text-xs text-slate-700 dark:text-slate-300">{finding.summary}</p>
              {finding.reproduction ? (
                <pre className="text-[11px] whitespace-pre-wrap break-all bg-slate-50 dark:bg-slate-900 rounded p-3 text-slate-700 dark:text-slate-300">
                  {finding.reproduction}
                </pre>
              ) : null}
              {finding.remediation ? (
                <p className="text-xs text-slate-600 dark:text-slate-400">{finding.remediation}</p>
              ) : null}
              {finding.evidence_json ? (
                <pre className="text-[11px] whitespace-pre-wrap break-all bg-slate-50 dark:bg-slate-900 rounded p-3 text-slate-600 dark:text-slate-400 max-h-64 overflow-auto">
                  {JSON.stringify(finding.evidence_json, null, 2)}
                </pre>
              ) : null}
              <div className="flex gap-3 text-[11px] text-slate-500">
                {finding.owasp_ref ? <span>OWASP {finding.owasp_ref}</span> : null}
                {finding.cwe_ref ? <span>{finding.cwe_ref}</span> : null}
                <span>check: {finding.check_slug}</span>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-slate-700 dark:text-slate-300">{children}</dd>
    </div>
  );
}

function Bubble({ role, text }: { role: string; text: string }) {
  if (role === "system") {
    return <p className="text-[11px] italic text-slate-400 text-center">{text}</p>;
  }
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
          isUser
            ? "bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900"
            : "bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200"
        }`}
      >
        {text}
      </div>
    </div>
  );
}

function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="mt-2 text-[11px] leading-relaxed rounded p-2 bg-slate-900 text-slate-100 overflow-x-auto max-h-56 overflow-y-auto">
      {diff.split("\n").map((line, i) => {
        const color = line.startsWith("+")
          ? "text-emerald-400"
          : line.startsWith("-")
            ? "text-red-400"
            : "text-slate-400";
        return (
          <div key={i} className={color}>
            {line || " "}
          </div>
        );
      })}
    </pre>
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
