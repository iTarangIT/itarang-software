"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SEVERITY_COLOR_TOKENS, SEVERITY_LABELS } from "@/lib/security/severity";
import { CATEGORY_LABELS } from "@/lib/security/types";
import type { FindingForUi } from "./SecurityFindings";
import ResolutionChat from "./ResolutionChat";

const STATUS_ACTIONS: Array<{ status: string; label: string }> = [
  { status: "acknowledged", label: "Acknowledge" },
  { status: "resolved", label: "Mark Resolved" },
  { status: "false_positive", label: "False Positive" },
  { status: "open", label: "Reopen" },
];

export default function FindingDrawer({
  finding,
  onClose,
}: {
  finding: FindingForUi;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const tok = SEVERITY_COLOR_TOKENS[finding.severity];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setStatus = async (status: string) => {
    setBusy(status);
    try {
      const res = await fetch(`/api/it/security/findings/${finding.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        onClose();
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose}>
      <div
        className="absolute right-0 top-0 bottom-0 w-full md:w-[640px] bg-white dark:bg-slate-950 shadow-2xl overflow-y-auto"
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
              <span className="text-[10px] uppercase tracking-wide text-slate-400">{finding.confidence}</span>
            </div>
            <h2 className="mt-2 text-lg font-semibold text-slate-900 dark:text-slate-100">{finding.title}</h2>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">
            ×
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 text-sm">
          <Section title="Summary">
            <p className="text-slate-700 dark:text-slate-300">{finding.summary}</p>
          </Section>

          <Section title="Target">
            <div className="flex items-center gap-2">
              {finding.http_method ? (
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                  {finding.http_method}
                </span>
              ) : null}
              <code className="text-xs break-all text-slate-700 dark:text-slate-300">{finding.target_url}</code>
            </div>
          </Section>

          {finding.reproduction ? (
            <Section title="Reproduction">
              <pre className="text-xs whitespace-pre-wrap break-all bg-slate-50 dark:bg-slate-900 rounded p-3 text-slate-700 dark:text-slate-300">
                {finding.reproduction}
              </pre>
            </Section>
          ) : null}

          {finding.remediation ? (
            <Section title="Remediation">
              <p className="text-slate-700 dark:text-slate-300">{finding.remediation}</p>
            </Section>
          ) : null}

          {finding.evidence_json ? (
            <Section title="Evidence">
              <pre className="text-[11px] whitespace-pre-wrap break-all bg-slate-50 dark:bg-slate-900 rounded p-3 text-slate-600 dark:text-slate-400 max-h-64 overflow-auto">
                {JSON.stringify(finding.evidence_json, null, 2)}
              </pre>
            </Section>
          ) : null}

          <div className="flex gap-3 text-xs text-slate-500">
            {finding.owasp_ref ? <span>OWASP {finding.owasp_ref}</span> : null}
            {finding.cwe_ref ? <span>{finding.cwe_ref}</span> : null}
            <span>check: {finding.check_slug}</span>
          </div>

          <Section title="Triage">
            <div className="flex flex-wrap gap-2">
              {STATUS_ACTIONS.filter((a) => a.status !== finding.status).map((a) => (
                <button
                  key={a.status}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setStatus(a.status)}
                  className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                >
                  {busy === a.status ? "…" : a.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-400">Current status: {finding.status.replace("_", " ")}</p>
          </Section>

          <Section title="AI Resolution">
            <ResolutionChat
              findingId={finding.id}
              status={finding.status}
              resolutionReport={finding.resolution_report}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">{title}</h4>
      {children}
    </div>
  );
}
