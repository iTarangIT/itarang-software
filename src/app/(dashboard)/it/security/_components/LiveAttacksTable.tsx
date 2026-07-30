"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { SEVERITY_COLOR_TOKENS, SEVERITY_LABELS, type Severity } from "@/lib/security/severity";

export interface EventForUi {
  id: string;
  occurred_at: string | null;
  event_type: string;
  severity: string;
  action: string;
  ip: string | null;
  actor_role: string | null;
  actor_user_id: string | null;
  method: string | null;
  path: string;
  query: string | null;
  user_agent: string | null;
  matched_rule: string | null;
  evidence: Record<string, unknown> | null;
  status: string;
}

const TYPE_LABEL: Record<string, string> = {
  // Payload rules (src/lib/security/detect.ts)
  sql_injection: "SQL injection",
  xss: "Cross-site scripting",
  path_traversal: "Path traversal",
  null_byte: "Null-byte injection",
  scanner_ua: "Scanner tool",
  sensitive_unauth: "Unauth sensitive access",
  command_injection: "Command injection",
  ssrf: "SSRF",
  lfi_rfi: "File inclusion",
  jndi_injection: "JNDI / Log4Shell",
  nosql_injection: "NoSQL injection",
  crlf_injection: "CRLF / response splitting",
  proto_pollution: "Prototype pollution",
  xxe: "XML external entity",
  open_redirect: "Open redirect",
  sensitive_file_probe: "Sensitive file probe",
  method_abuse: "HTTP method abuse",
  // Volumetric / behavioural rules (src/lib/security/rate-watch.ts)
  rate_flood: "Request flood (DoS)",
  path_enumeration: "Path enumeration",
  auth_bruteforce: "Auth brute-force",
  burst: "Request burst",
};

/** Filter dropdown order — grouped, most-severe families first. */
const TYPE_OPTIONS = Object.keys(TYPE_LABEL);

export default function LiveAttacksTable({ events }: { events: EventForUi[] }) {
  const [sev, setSev] = useState("");
  const [type, setType] = useState("");
  const [action, setAction] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<EventForUi | null>(null);

  const rows = useMemo(
    () =>
      events
        .filter((e) => (sev ? e.severity === sev : true))
        .filter((e) => (type ? e.event_type === type : true))
        .filter((e) => (action ? e.action === action : true))
        .filter((e) => (status ? e.status === status : true)),
    [events, sev, type, action, status],
  );

  const sel = "text-xs rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select className={sel} value={sev} onChange={(e) => setSev(e.target.value)}>
          <option value="">All severities</option>
          {(["critical", "high", "medium", "low", "info"] as const).map((s) => (
            <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>
          ))}
        </select>
        <select className={sel} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All attack types</option>
          {TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>{TYPE_LABEL[t]}</option>
          ))}
        </select>
        <select className={sel} value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          <option value="blocked">Blocked</option>
          <option value="logged">Logged</option>
        </select>
        <select className={sel} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="new">New</option>
          <option value="reviewed">Reviewed</option>
          <option value="ignored">Ignored</option>
        </select>
        <span className="text-xs text-slate-500 self-center ml-auto">{rows.length} event{rows.length === 1 ? "" : "s"}</span>
      </div>

      {rows.length === 0 ? (
        <div className="text-center text-sm text-slate-500 py-16 border border-dashed border-slate-300 dark:border-slate-700 rounded-lg">
          No attack events match the filters. When detection is enabled, hostile requests appear here in real time.
        </div>
      ) : (
        <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-xl">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-900 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2.5 font-semibold">Time</th>
                <th className="px-3 py-2.5 font-semibold">Severity</th>
                <th className="px-3 py-2.5 font-semibold">Type</th>
                <th className="px-3 py-2.5 font-semibold">Action</th>
                <th className="px-3 py-2.5 font-semibold">Source IP</th>
                <th className="px-3 py-2.5 font-semibold">Target</th>
                <th className="px-3 py-2.5 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const tok = SEVERITY_COLOR_TOKENS[(e.severity as Severity)] ?? SEVERITY_COLOR_TOKENS.info;
                return (
                  <tr
                    key={e.id}
                    onClick={() => setOpen(e)}
                    className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900/50 cursor-pointer"
                  >
                    <td className="px-3 py-2.5 whitespace-nowrap text-slate-500 text-xs">
                      {e.occurred_at ? new Date(e.occurred_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${tok.fg}`}>
                        <span className={`h-2 w-2 rounded-full ${tok.dot}`} />
                        {SEVERITY_LABELS[(e.severity as Severity)] ?? e.severity}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-700 dark:text-slate-300">{TYPE_LABEL[e.event_type] ?? e.event_type}</td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${
                          e.action === "blocked"
                            ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                            : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                        }`}
                      >
                        {e.action}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-600 dark:text-slate-400">{e.ip ?? "—"}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-600 dark:text-slate-400 max-w-[240px] truncate" title={`${e.method ?? ""} ${e.path}`}>
                      {e.method} {e.path}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="text-[11px] capitalize text-slate-500">{e.status}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && <EventDrawer event={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function EventDrawer({ event, onClose }: { event: EventForUi; onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const tok = SEVERITY_COLOR_TOKENS[(event.severity as Severity)] ?? SEVERITY_COLOR_TOKENS.info;

  const setStatus = async (status: string) => {
    setBusy(status);
    try {
      const res = await fetch(`/api/it/security/events/${event.id}`, {
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
        className="absolute right-0 top-0 bottom-0 w-full md:w-[600px] bg-white dark:bg-slate-950 shadow-2xl overflow-y-auto"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="sticky top-0 bg-white dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 px-6 py-4 flex items-start justify-between gap-4">
          <div>
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${tok.fg}`}>
              <span className={`h-2 w-2 rounded-full ${tok.dot}`} />
              {SEVERITY_LABELS[(event.severity as Severity)] ?? event.severity}
            </span>
            <h2 className="mt-1.5 text-lg font-semibold">{TYPE_LABEL[event.event_type] ?? event.event_type}</h2>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-5 space-y-4 text-sm">
          <Row k="When" v={event.occurred_at ? new Date(event.occurred_at).toLocaleString() : "—"} />
          <Row k="Action" v={event.action} />
          <Row k="Rule" v={event.matched_rule ?? "—"} />
          <Row k="Source IP" v={event.ip ?? "—"} mono />
          <Row k="Target" v={`${event.method ?? ""} ${event.path}`} mono />
          {event.query ? <Row k="Query" v={event.query} mono /> : null}
          <Row k="Actor" v={event.actor_role ? `${event.actor_role}${event.actor_user_id ? ` (${event.actor_user_id})` : ""}` : "unauthenticated"} />
          {event.user_agent ? <Row k="User-Agent" v={event.user_agent} mono /> : null}
          {event.evidence ? (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">Evidence</div>
              <pre className="text-[11px] whitespace-pre-wrap break-all bg-slate-50 dark:bg-slate-900 rounded p-3 text-slate-600 dark:text-slate-400 max-h-64 overflow-auto">
                {JSON.stringify(event.evidence, null, 2)}
              </pre>
            </div>
          ) : null}

          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">Triage</div>
            <div className="flex flex-wrap gap-2">
              {["reviewed", "ignored", "new"].filter((s) => s !== event.status).map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setStatus(s)}
                  className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 capitalize"
                >
                  {busy === s ? "…" : `Mark ${s}`}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-3">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 w-24 flex-none pt-0.5">{k}</span>
      <span className={`text-slate-700 dark:text-slate-300 break-all ${mono ? "font-mono text-xs" : ""}`}>{v}</span>
    </div>
  );
}
