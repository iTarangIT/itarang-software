"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { SEVERITY_COLOR_TOKENS, SEVERITY_LABELS, type Severity } from "@/lib/security/severity";
import { impactFor } from "@/lib/security/impact";

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

/** 30-day history for one source IP, aggregated in the page query. */
export interface IpProfile {
  events: number;
  blocked: number;
  firstSeen: string | null;
  lastSeen: string | null;
  types: string[];
  paths: number;
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
  // Auto-block (src/lib/security/blocklist.ts) — a request refused because its
  // source IP was already banned, not because this particular request matched.
  ip_blocked: "Banned IP refused",
};

/** Filter dropdown order — grouped, most-severe families first. */
const TYPE_OPTIONS = Object.keys(TYPE_LABEL);

/**
 * True when the row was POSTed straight to the internal ingest API instead of
 * being raised by the detector on a real request — so its source IP is a value
 * someone typed, not one observed on the wire. Stamped by the ingest route.
 */
function isSynthetic(e: EventForUi): boolean {
  const p = (e.evidence as Record<string, unknown> | null)?.provenance;
  return !!p && typeof p === "object" && (p as { reporter?: string }).reporter === "manual-api-post";
}

export default function LiveAttacksTable({
  events,
  ipProfiles = {},
}: {
  events: EventForUi[];
  ipProfiles?: Record<string, IpProfile>;
}) {
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
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-600 dark:text-slate-400">
                      {e.ip ?? "—"}
                      {isSynthetic(e) ? (
                        // The address on a hand-POSTed test row is typed, not
                        // observed. Saying so in the table stops it being read
                        // as a real attacker at a glance.
                        <span
                          className="ml-2 font-sans text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                          title="Posted directly to the ingest API — the IP was supplied by the poster, not observed on a request."
                        >
                          test
                        </span>
                      ) : null}
                    </td>
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

      {open && (
        <EventDrawer
          event={open}
          profile={open.ip ? ipProfiles[open.ip] ?? null : null}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function EventDrawer({
  event,
  profile,
  onClose,
}: {
  event: EventForUi;
  profile: IpProfile | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const tok = SEVERITY_COLOR_TOKENS[(event.severity as Severity)] ?? SEVERITY_COLOR_TOKENS.info;

  // The middleware files request context under fixed keys (src/middleware.ts →
  // src/lib/security/fingerprint.ts) so each can be rendered as what it is,
  // instead of every one of them landing in an undifferentiated JSON blob.
  // Whatever is left over is the RULE's own evidence — the matched payload.
  const { net, client, geo, ban, provenance, flags, bodySample, ruleEvidence } = useMemo(() => {
    const all = { ...((event.evidence ?? {}) as Record<string, unknown>) };
    const take = (k: string): Record<string, unknown> | null => {
      const v = all[k];
      delete all[k];
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    };
    const n = take("net");
    const c = take("client");
    const g = take("geo");
    const b = take("ban");
    const p = take("provenance");
    // `request` duplicates the row's own columns — drop it rather than show
    // the same method/path twice.
    delete all.request;
    const f = Array.isArray(all.flags) ? (all.flags as string[]) : [];
    delete all.flags;
    const body = typeof all.body_sample === "string" ? all.body_sample : null;
    delete all.body_sample;
    return { net: n, client: c, geo: g, ban: b, provenance: p, flags: f, bodySample: body, ruleEvidence: all };
  }, [event.evidence]);

  const hasRuleEvidence = Object.keys(ruleEvidence).length > 0;
  const synthetic = str(provenance?.reporter) === "manual-api-post";

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

        <div className="px-6 py-5 space-y-5 text-sm">
          {synthetic ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3.5">
              <div className="text-[13px] font-semibold text-amber-900 dark:text-amber-200">
                Synthetic test event — not a real attack
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-amber-800 dark:text-amber-300/90">
                This row was created by POSTing directly to the internal ingest API, not by a
                request arriving at the CRM. The source IP below is <b>whatever the poster typed</b>
                {str(provenance?.ip_observed_at_ingest)
                  ? ` — the address the post actually came from was ${str(provenance?.ip_observed_at_ingest)}`
                  : ""}
                . It is not evidence of anything, and no attacker detail could be captured because
                there was no attacking request. Genuine detector events are marked{" "}
                <span className="font-mono">reporter: middleware</span> and carry the full profile.
              </p>
            </div>
          ) : null}

          {ban ? (
            <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-900 p-3.5">
              <div className="text-[13px] font-semibold text-red-800 dark:text-red-300">
                Source IP banned — every request from it is now refused
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-red-800/90 dark:text-red-300/90">
                {str(ban.reason)}
              </p>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-red-800/80 dark:text-red-300/80">
                {str(ban.blocked_until) ? (
                  <span>
                    Ban lifts at <b>{new Date(String(ban.blocked_until)).toLocaleString()}</b>
                  </span>
                ) : null}
                {typeof ban.strikes === "number" ? <span>Strikes: {ban.strikes}</span> : null}
                {typeof ban.previous_bans === "number" && ban.previous_bans > 0 ? (
                  <span>Previously banned {ban.previous_bans}×</span>
                ) : null}
              </div>
            </div>
          ) : null}

          <ImpactPanel eventType={event.event_type} action={event.action} />

          {/* ── What was sent ─────────────────────────────────────────────── */}
          <Section title="The request">
            <Row k="When" v={event.occurred_at ? new Date(event.occurred_at).toLocaleString() : "—"} />
            <Row k="Action" v={event.action === "blocked" ? "Blocked (403)" : "Logged, allowed through"} />
            <Row k="Rule" v={event.matched_rule ?? "—"} />
            <Row k="Target" v={`${event.method ?? ""} ${event.path}`} mono />
            {event.query ? <Row k="Query" v={event.query} mono /> : null}
            {str(net?.host) ? <Row k="Host" v={String(net?.host)} mono /> : null}
            {str(net?.referer) ? <Row k="Referer" v={String(net?.referer)} mono /> : null}
            {str(net?.origin) ? <Row k="Origin" v={String(net?.origin)} mono /> : null}
          </Section>

          {/* ── Who sent it ───────────────────────────────────────────────── */}
          <Section title="The attacker">
            <div className="flex gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 w-24 flex-none pt-0.5">
                Source IP
              </span>
              <span className="text-slate-700 dark:text-slate-300 break-all font-mono text-xs">
                {event.ip ?? "—"}
                {str(net?.ip_source) ? (
                  <span className="ml-2 font-sans text-[11px] text-slate-400">
                    observed via {String(net?.ip_source)}
                  </span>
                ) : null}
                {str(net?.ip_scope) && net?.ip_scope !== "public" ? (
                  <span className="ml-2 font-sans text-[11px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    {String(net?.ip_scope)} address — from inside the network
                  </span>
                ) : null}
                {net?.client_supplied_xff ? (
                  <span className="ml-2 font-sans text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                    tried to forge X-Forwarded-For — see proxy chain
                  </span>
                ) : null}
              </span>
            </div>

            {geo ? (
              <Row
                k="Location"
                v={[str(geo.city), str(geo.region), str(geo.country)].filter(Boolean).join(", ") || "—"}
              />
            ) : null}

            {client ? (
              <>
                <Row
                  k="Client"
                  v={
                    str(client.tool)
                      ? `${clientKindLabel(str(client.kind))} — ${String(client.tool)}`
                      : str(client.browser)
                        ? `${clientKindLabel(str(client.kind))} — ${String(client.browser)}`
                        : clientKindLabel(str(client.kind))
                  }
                />
                {str(client.accept_language) ? (
                  <Row k="Language" v={String(client.accept_language)} />
                ) : null}
                <Row
                  k="Session"
                  v={
                    event.actor_role
                      ? `Authenticated as ${event.actor_role}${event.actor_user_id ? ` (${event.actor_user_id})` : ""}`
                      : client.has_cookies
                        ? "Unauthenticated, but sent cookies"
                        : "Unauthenticated, no cookies — direct machine request"
                  }
                />
              </>
            ) : (
              <Row
                k="Actor"
                v={
                  event.actor_role
                    ? `${event.actor_role}${event.actor_user_id ? ` (${event.actor_user_id})` : ""}`
                    : "unauthenticated"
                }
              />
            )}
            {event.user_agent ? <Row k="User-Agent" v={event.user_agent} mono /> : null}

            {profile && profile.events > 1 ? (
              <div className="mt-1 rounded-md bg-slate-50 dark:bg-slate-900 p-3 text-[12px] text-slate-600 dark:text-slate-400 leading-relaxed">
                <b className="text-slate-700 dark:text-slate-300">History for this IP (30 days):</b>{" "}
                {profile.events} events, {profile.blocked} blocked, across {profile.paths} distinct
                paths.
                {profile.firstSeen ? ` First seen ${new Date(profile.firstSeen).toLocaleString()}.` : ""}
                {profile.types.length ? (
                  <span className="block mt-1.5">
                    Attack types tried:{" "}
                    {profile.types.map((t) => TYPE_LABEL[t] ?? t).join(", ")}.
                  </span>
                ) : null}
              </div>
            ) : null}

            {flags.length > 0 ? (
              <ul className="mt-1 space-y-1">
                {flags.map((f) => (
                  <li
                    key={f}
                    className="text-[12px] leading-relaxed text-slate-600 dark:text-slate-400 pl-3 border-l-2 border-slate-300 dark:border-slate-700"
                  >
                    {f}
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>

          {/* ── The payload itself ────────────────────────────────────────── */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">Evidence</div>
            {hasRuleEvidence ? (
              <pre className="text-[11px] whitespace-pre-wrap break-all bg-slate-50 dark:bg-slate-900 rounded p-3 text-slate-600 dark:text-slate-400 max-h-64 overflow-auto">
                {JSON.stringify(ruleEvidence, null, 2)}
              </pre>
            ) : (
              <p className="text-xs text-slate-500 bg-slate-50 dark:bg-slate-900 rounded p-3 leading-relaxed">
                {synthetic
                  ? "None — this event was posted straight to the ingest API, so there was no request to take evidence from."
                  : "The rule recorded no extra evidence. The target path and query above are the full observable payload for this event type."}
              </p>
            )}
          </div>

          {bodySample ? (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
                Request body (first 1 KB)
              </div>
              <pre className="text-[11px] whitespace-pre-wrap break-all bg-slate-50 dark:bg-slate-900 rounded p-3 text-slate-600 dark:text-slate-400 max-h-64 overflow-auto">
                {bodySample}
              </pre>
            </div>
          ) : null}

          {net?.forwarded_chain && Object.keys(net.forwarded_chain as Record<string, string>).length > 0 ? (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
                Proxy chain — what each hop claimed
              </div>
              <pre className="text-[11px] whitespace-pre-wrap break-all bg-slate-50 dark:bg-slate-900 rounded p-3 text-slate-600 dark:text-slate-400">
                {JSON.stringify(net.forwarded_chain, null, 2)}
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

/**
 * "So what?" for the event — what was attempted, what it would have cost this
 * CRM, and what to do next. Copy lives in src/lib/security/impact.ts.
 *
 * The blocked/logged distinction is stated explicitly: the impact text is
 * always hypothetical (what WOULD have happened), and a responder reading a
 * Critical badge needs to know immediately whether it was stopped.
 */
function ImpactPanel({ eventType, action }: { eventType: string; action: string }) {
  const impact = impactFor(eventType);
  const blocked = action === "blocked";

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 p-4 space-y-3">
      <div
        className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded ${
          blocked
            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
            : "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        }`}
      >
        {blocked
          ? "Blocked — the request never reached the application"
          : "Logged only — the request was allowed through"}
      </div>

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
          What was attempted
        </div>
        <p className="text-[13px] leading-relaxed text-slate-700 dark:text-slate-300">{impact.what}</p>
      </div>

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
          Risk to the CRM if it succeeded
        </div>
        <p className="text-[13px] leading-relaxed text-slate-700 dark:text-slate-300">{impact.crmRisk}</p>
      </div>

      {impact.assets.length > 0 ? (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
            In the blast radius
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {impact.assets.map((a) => (
              <li
                key={a}
                className="text-[11px] px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400"
              >
                {a}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
          Recommended action
        </div>
        <p className="text-[13px] leading-relaxed text-slate-700 dark:text-slate-300">{impact.response}</p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 border-b border-slate-200 dark:border-slate-800 pb-1.5">
        {title}
      </div>
      {children}
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

/** Narrow an unknown jsonb value to a non-empty string, or null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Plain-language name for the sender classification set in fingerprint.ts. */
function clientKindLabel(kind: string | null): string {
  switch (kind) {
    case "scanner":
      return "Attack tool";
    case "tool":
      return "Scripted HTTP client";
    case "bot":
      return "Crawler / bot";
    case "browser":
      return "Browser";
    default:
      return "Unidentified client";
  }
}
