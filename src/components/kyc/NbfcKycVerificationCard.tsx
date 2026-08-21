"use client";

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";

// Change 6 — the admin's "NBFC KYC Verification" card in the KYC case-review.
// One place where the admin sees, per NBFC: every per-document verdict the NBFC
// recorded, and every correction / additional-document request it raised — with
// controls to Forward the request to the dealer, Push the finished docs back to
// the NBFC, Decline, or post a direct message to the NBFC (Change 3).

interface VerdictAttachment {
  url: string;
  name: string;
  type: string;
  size: number;
}
interface Verdict {
  id: number;
  nbfc_id: number;
  doc_for: string;
  doc_key: string;
  verdict: string;
  notes: string | null;
  attachments: VerdictAttachment[] | null;
  // E-209 — set once the admin has forwarded this verdict to the dealer.
  forwarded_at: string | null;
  forwarded_request_id: string | null;
  // E-254 — the leg-1 SLA clock and who forwarded it.
  sla_due_at?: string | null;
  forward_source?: string | null;
  sla_failure?: string | null;
}
interface ReqItem {
  id: string;
  doc_label: string;
  upload_status: string | null;
  file_url: string | null;
  rejection_reason: string | null;
}
interface Wrapper {
  id: string;
  assignment_id: string;
  nbfc_id: number;
  request_type: string;
  status: string;
  doc_for: string;
  target_doc_key: string | null;
  nbfc_comments: string | null;
  admin_notes: string | null;
  // E-210 — documents the admin uploaded and sent to the NBFC with this
  // message, and the verdict the message answers (if any).
  attachments: VerdictAttachment[] | null;
  verdict_id: number | null;
  // E-240 — the NBFC sent this straight to the dealer, skipping the forward
  // gate. Read-only here: there is nothing for the admin to forward or push.
  dealer_direct?: boolean | null;
  created_at: string;
  // E-254 — the SLA clock of the current leg and the provenance of each hop.
  sla_due_at?: string | null;
  forward_source?: string | null;
  push_source?: string | null;
  auto_forwarded_at?: string | null;
  auto_pushed_at?: string | null;
  sla_failure?: string | null;
}
// E-254 — what the settings page currently says, so the card can explain a
// missing clock ("SLA is off" vs "raised before it was switched on").
interface SlaInfo {
  enabled: boolean;
  forwardSlaMinutes: number;
  pushSlaMinutes: number;
  autoForwardToDealer: boolean;
  autoPushToNbfc: boolean;
}
// E-240 — one turn of the NBFC ⇄ Dealer conversation on a direct request.
interface ThreadMessage {
  id: string;
  party: string;
  message: string | null;
  attachments: VerdictAttachment[] | null;
  created_at: string;
}
interface Entry {
  request: Wrapper;
  items: ReqItem[];
  messages?: ThreadMessage[];
}

const STATUS_LABEL: Record<string, string> = {
  nbfc_raised: "Raised — review",
  admin_review: "With admin",
  forwarded_to_dealer: "Forwarded to dealer",
  with_customer: "Collecting from customer",
  dealer_review: "Dealer reviewing",
  admin_review_upload: "Upload ready — review",
  pushed_to_nbfc: "Pushed to NBFC",
  closed: "Closed",
  rejected: "Declined",
};

// The manual-consent wrapper carries the NBFC's uploaded consent-document URL
// inline in its comments ("Document: <url>") — linkify it so the admin can open
// and review the document before forwarding it to the dealer for signing.
const URL_RE = /(https?:\/\/[^\s]+)/g;
function firstUrl(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(URL_RE);
  return m?.[0] ?? null;
}
function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a
            key={i}
            href={p}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-[color:var(--color-brand-sky)] hover:underline break-all"
          >
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** "1h 12m" / "3d 4h" / "4m 09s" — same shape as the KYC case-header countdown. */
function formatSpan(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * E-254 — one chip that says what the SLA clock will do to this row and when.
 * `now` is the parent's tick, offset to the server clock, so every chip on
 * the card counts down together against the clock the sweep actually uses.
 */
function SlaChip({
  dueAt,
  now,
  action,
  sla,
  legOn,
}: {
  dueAt: string | null | undefined;
  now: number;
  /** What happens at expiry. */
  action: "forward" | "push";
  sla: SlaInfo | null;
  /** Whether this leg's auto action is switched on in settings. */
  legOn: boolean;
}) {
  const verb = action === "forward" ? "Auto-forwards to dealer" : "Auto-pushes to NBFC";
  if (!dueAt) {
    if (!sla || !sla.enabled || !legOn) return null; // feature off — say nothing
    // Feature on but this row carries no clock: it was already waiting when
    // the switch was flipped, and enabling never reaches back.
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500"
        title="This request was already waiting when the SLA was switched on, so it carries no deadline — it needs a manual action."
      >
        No SLA clock · manual
      </span>
    );
  }
  const remaining = new Date(dueAt).getTime() - now;
  if (!Number.isFinite(remaining)) return null;
  const overdue = remaining <= 0;
  const soon = remaining > 0 && remaining < 15 * 60_000;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        overdue
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : soon
            ? "border-amber-200 bg-amber-50 text-amber-700"
            : "border-violet-200 bg-violet-50 text-violet-700"
      }`}
      title={`Deadline ${new Date(dueAt).toLocaleString("en-IN")}`}
    >
      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {overdue ? `${verb} shortly (overdue)` : `${verb} in ${formatSpan(remaining)}`}
    </span>
  );
}

/** E-254 — provenance badge: this hop was done by the sweep, not a person. */
function AutoBadge({ kind, at }: { kind: "forwarded" | "pushed"; at?: string | null }) {
  const label = kind === "forwarded" ? "Forwarded automatically (SLA)" : "Pushed automatically (SLA)";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700"
      title={
        at
          ? `${label} on ${new Date(at).toLocaleString("en-IN")}${kind === "pushed" ? " — nobody at iTarang opened the uploads." : ""}`
          : label
      }
    >
      ⚡ {label}
    </span>
  );
}

/** E-254 — the sweep tried and threw; the row is back with the admin. */
function SlaFailure({ message }: { message: string }) {
  return (
    <p className="mt-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
      <strong>Auto-routing failed:</strong> {message} — please action this manually.
    </p>
  );
}

export default function NbfcKycVerificationCard({ leadId }: { leadId: string }) {
  const [thread, setThread] = useState<Entry[]>([]);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  // E-254 — SLA settings + a server-clock offset so countdowns tick against
  // the database's clock, not this browser's.
  const [sla, setSla] = useState<SlaInfo | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  // forward composer: requestId → comma/line separated labels
  const [forwardFor, setForwardFor] = useState<string | null>(null);
  const [forwardLabels, setForwardLabels] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  // Per-verdict message the admin must type before forwarding to the dealer.
  const [verdictMsg, setVerdictMsg] = useState<Record<number, string>>({});
  // Per-child rejection-reason drafts for the re-uploaded doc under a verdict.
  const [childReject, setChildReject] = useState<Record<string, string>>({});
  // E-210 — the admin's own upload composer per verdict: files + note, sent
  // straight to the NBFC without a dealer round-trip.
  const [replyFiles, setReplyFiles] = useState<Record<number, File[]>>({});
  const [replyMsg, setReplyMsg] = useState<Record<number, string>>({});
  // Bumped after a successful send so the <input type="file"> remounts empty.
  const [replyReset, setReplyReset] = useState<Record<number, number>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/nbfc-requests?leadId=${leadId}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (json.success) {
        setThread(json.data.thread ?? []);
        setVerdicts(json.data.verdicts ?? []);
        setSla(json.data.sla ?? null);
        if (json.data.serverNow) {
          const serverMs = new Date(json.data.serverNow).getTime();
          if (Number.isFinite(serverMs)) setClockOffset(serverMs - Date.now());
        }
      }
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load]);

  // E-254 — one shared tick for every countdown chip. Only runs while there is
  // a clock to show, and re-polls the thread once a minute so a row the sweep
  // just moved does not sit here showing "overdue" until the next manual refresh.
  const anyClock =
    thread.some((e) => !!e.request.sla_due_at) || verdicts.some((v) => !!v.sla_due_at);
  useEffect(() => {
    if (!anyClock) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    const r = setInterval(() => void load(), 60_000);
    return () => {
      clearInterval(t);
      clearInterval(r);
    };
  }, [anyClock, load]);
  const serverNow = now + clockOffset;

  const forward = async (requestId: string) => {
    // For a manual-consent request, attach the NBFC's uploaded consent document
    // to each forwarded item so the dealer knows exactly which document the
    // customer must sign before uploading the signed copy back.
    const wrapper = thread.find((e) => e.request.id === requestId)?.request;
    const consentUrl =
      wrapper?.request_type === "manual_consent"
        ? firstUrl(wrapper.nbfc_comments)
        : null;
    const reason = consentUrl
      ? `Print/share the NBFC consent document (${consentUrl}), obtain the customer's signature, then upload the signed copy.`
      : undefined;
    const items = forwardLabels
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((doc_label) => ({ doc_label, ...(reason ? { reason } : {}) }));
    if (items.length === 0) {
      setBanner("Enter at least one document label to forward.");
      return;
    }
    setBusy(requestId);
    setBanner(null);
    try {
      const res = await fetch(`/api/admin/nbfc-requests/${requestId}/forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "forward", items }),
      });
      const json = await res.json();
      if (json.success) {
        setForwardFor(null);
        setForwardLabels("");
        await load();
      } else {
        setBanner(json.error?.message ?? "Forward failed");
      }
    } finally {
      setBusy(null);
    }
  };

  const simpleAction = async (
    requestId: string,
    kind: "decline" | "push",
  ) => {
    setBusy(requestId);
    setBanner(null);
    try {
      const url =
        kind === "push"
          ? `/api/admin/nbfc-requests/${requestId}/push`
          : `/api/admin/nbfc-requests/${requestId}/forward`;
      const body =
        kind === "push" ? {} : { action: "decline" };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) setBanner(json.error?.message ?? `${kind} failed`);
      await load();
    } finally {
      setBusy(null);
    }
  };

  // One-click action for an NBFC-initiated co-borrower request: triggers the
  // standard dealer co-borrower KYC flow with the NBFC's reason, then pushes the
  // wrapper back to the NBFC.
  const requestCoBorrower = async (requestId: string) => {
    setBusy(requestId);
    setBanner(null);
    try {
      const res = await fetch(
        `/api/admin/nbfc-requests/${requestId}/request-coborrower`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const json = await res.json();
      if (!json.success) {
        setBanner(json.error?.message ?? "Could not request co-borrower");
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  // Direct admin → NBFC post. Multipart when the admin attached documents
  // (E-210), plain JSON otherwise — the route accepts both.
  const postMessage = async (
    assignmentId: string,
    message: string,
    files: File[] = [],
  ) => {
    if (!message.trim()) return;
    setBusy(assignmentId);
    try {
      let init: RequestInit;
      if (files.length > 0) {
        const fd = new FormData();
        fd.append("assignmentId", assignmentId);
        fd.append("message", message);
        for (const f of files) fd.append("files", f);
        init = { method: "POST", body: fd };
      } else {
        init = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assignmentId, message }),
        };
      }
      const res = await fetch(`/api/admin/nbfc-requests`, init);
      const json = await res.json();
      if (!json.success) setBanner(json.error?.message ?? "Message failed");
      await load();
    } finally {
      setBusy(null);
    }
  };

  // Forward an NBFC per-document verdict to the dealer as a re-upload request.
  // A primary/customer verdict lands on Step 2; a co-borrower verdict on Step 3.
  const forwardVerdict = async (verdictId: number) => {
    const message = (verdictMsg[verdictId] ?? "").trim();
    if (!message) {
      setBanner("Type a message for the dealer before forwarding.");
      return;
    }
    const key = `verdict-${verdictId}`;
    setBusy(key);
    setBanner(null);
    try {
      const res = await fetch(
        `/api/admin/nbfc-requests/verdicts/${verdictId}/forward`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        },
      );
      const json = await res.json();
      if (!json.success) {
        setBanner(json.error?.message ?? "Forward failed");
      } else {
        setVerdictMsg((prev) => {
          const next = { ...prev };
          delete next[verdictId];
          return next;
        });
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  // E-210 — the admin uploads the customer document himself and sends it, with
  // a note, straight to the NBFC (no dealer round-trip). Multipart POST.
  const sendVerdictDocs = async (verdictId: number) => {
    const files = replyFiles[verdictId] ?? [];
    const message = (replyMsg[verdictId] ?? "").trim();
    if (files.length === 0) {
      setBanner("Choose at least one document to send to the NBFC.");
      return;
    }
    if (!message) {
      setBanner("Type a message for the NBFC before sending.");
      return;
    }
    const key = `reply-${verdictId}`;
    setBusy(key);
    setBanner(null);
    try {
      const fd = new FormData();
      fd.append("message", message);
      for (const f of files) fd.append("files", f);
      const res = await fetch(
        `/api/admin/nbfc-requests/verdicts/${verdictId}/respond`,
        { method: "POST", body: fd },
      );
      const json = await res.json();
      if (!json.success) {
        setBanner(json.error?.message ?? "Could not send the document");
      } else {
        setReplyFiles((prev) => {
          const next = { ...prev };
          delete next[verdictId];
          return next;
        });
        setReplyMsg((prev) => {
          const next = { ...prev };
          delete next[verdictId];
          return next;
        });
        setReplyReset((prev) => ({ ...prev, [verdictId]: (prev[verdictId] ?? 0) + 1 }));
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  // Approve / reject the dealer's re-uploaded doc directly under the verdict.
  // Approve of the last outstanding doc auto-pushes the request to the NBFC
  // (handled server-side in the supporting-docs review route).
  const reviewChild = async (
    childId: string,
    action: "approve" | "reject",
  ) => {
    const reason = (childReject[childId] ?? "").trim();
    if (action === "reject" && !reason) {
      setBanner("Enter a rejection reason for the dealer.");
      return;
    }
    setBusy(`child-${childId}`);
    setBanner(null);
    try {
      const res = await fetch(
        `/api/admin/kyc/${leadId}/supporting-docs/${childId}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            rejection_reason: action === "reject" ? reason : undefined,
          }),
        },
      );
      const json = await res.json();
      if (!json.success) {
        setBanner(json.error?.message ?? "Review failed");
      } else {
        if (json.data?.pushed_to_nbfc) {
          setBanner(
            "Approved — the corrected document has been sent back to the NBFC.",
          );
        }
        setChildReject((prev) => {
          const next = { ...prev };
          delete next[childId];
          return next;
        });
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (loading) return null;

  const isEmpty = thread.length === 0 && verdicts.length === 0;

  // Quick lookup of the wrapper (+ its re-uploaded child docs) a forwarded
  // verdict spawned, keyed by wrapper id.
  const wrapperById = new Map<string, Entry>(
    thread.map((e) => [e.request.id, e]),
  );

  // Wrappers spawned by a forwarded verdict are shown under that verdict, so
  // drop them from the standalone thread list below to avoid duplication.
  const verdictWrapperIds = new Set(
    verdicts
      .map((v) => v.forwarded_request_id)
      .filter((x): x is string => !!x),
  );
  // E-210 — admin replies (documents the admin sent to the NBFC himself) are
  // grouped under the verdict they answer, not in the standalone list.
  const repliesByVerdict = new Map<number, Entry[]>();
  for (const e of thread) {
    const vid = e.request.verdict_id;
    if (vid == null) continue;
    const arr = repliesByVerdict.get(vid) ?? [];
    arr.push(e);
    repliesByVerdict.set(vid, arr);
  }

  // A reply is hidden here only while its verdict is on screen to host it. If
  // the NBFC has since approved the document the verdict drops out of the feed
  // (approvals never reach the admin), so the reply falls back to the list
  // below rather than disappearing with it.
  const shownVerdictIds = new Set(verdicts.map((v) => v.id));
  const standaloneThread = thread.filter(
    (e) =>
      !verdictWrapperIds.has(e.request.id) &&
      !(e.request.verdict_id != null && shownVerdictIds.has(e.request.verdict_id)),
  );

  // Group verdicts by NBFC for the summary strip.
  const verdictsByNbfc = new Map<number, Verdict[]>();
  for (const v of verdicts) {
    const arr = verdictsByNbfc.get(v.nbfc_id) ?? [];
    arr.push(v);
    verdictsByNbfc.set(v.nbfc_id, arr);
  }

  // Change 6 — this is the single, clearly-separated "NBFC" section of the admin
  // KYC review. Every NBFC-originated action for the lead surfaces here: per-doc
  // verdicts, and the request thread (corrections, additional-docs, co-borrower,
  // manual-consent uploads, and admin↔NBFC direct messages). Always rendered so
  // the section is a consistent, labelled home for NBFC activity.
  return (
    <div className="rounded-2xl border-2 border-[color:var(--color-brand-navy,#1e3a5f)]/15 bg-[color:var(--color-brand-navy,#1e3a5f)]/[0.03] p-5">
      <div className="mb-4 flex items-center gap-2.5">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-[color:var(--color-brand-navy,#1e3a5f)] text-white text-[11px] font-bold">
          N
        </span>
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-navy,#1e3a5f)]">
            NBFC Actions
          </h3>
          <p className="text-[11px] text-slate-500">
            What the NBFC partner needs from iTarang on this lead — rejections
            and correction requests. Approvals stay with the NBFC.
          </p>
        </div>
      </div>

      {banner ? (
        <p className="mb-3 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
          {banner}
        </p>
      ) : null}

      {isEmpty ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-400">
          Nothing needs your attention. Rejections, correction requests,
          co-borrower requests and consent uploads from the NBFC will appear
          here — approved documents don&apos;t.
        </p>
      ) : null}

      {verdicts.length > 0 ? (
        <div className="mb-4">
          <p className="mb-1.5 text-xs font-semibold text-slate-500">
            Documents the NBFC rejected or wants corrected
          </p>
          <ul className="space-y-1.5">
            {verdicts.map((v) => {
              const tone =
                v.verdict === "verified"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : v.verdict === "rejected"
                    ? "border-rose-200 bg-rose-50 text-rose-700"
                    : v.verdict === "queried"
                      ? "border-amber-200 bg-amber-50 text-amber-700"
                      : "border-slate-200 bg-slate-50 text-slate-600";
              const label =
                v.verdict === "verified"
                  ? "Approved"
                  : v.verdict === "rejected"
                    ? "Rejected"
                    : v.verdict === "queried"
                      ? "Correction requested"
                      : v.verdict;
              return (
                <li
                  key={v.id}
                  className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-700">
                      {v.doc_for === "co_borrower" ? "Co-borrower · " : ""}
                      {v.doc_key}
                    </span>
                    <span className="flex flex-wrap items-center justify-end gap-1.5">
                      {/* E-254 — leg-1 clock on an unforwarded ask; provenance once forwarded. */}
                      {(v.verdict === "queried" || v.verdict === "rejected") && !v.forwarded_at ? (
                        <SlaChip
                          dueAt={v.sla_due_at}
                          now={serverNow}
                          action="forward"
                          sla={sla}
                          legOn={!!sla?.autoForwardToDealer}
                        />
                      ) : null}
                      {v.forwarded_at && v.forward_source === "system" ? (
                        <AutoBadge kind="forwarded" at={v.forwarded_at} />
                      ) : null}
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}
                      >
                        {label}
                      </span>
                    </span>
                  </div>
                  {v.sla_failure && !v.forwarded_at ? <SlaFailure message={v.sla_failure} /> : null}
                  {v.notes ? (
                    <p className="mt-1 whitespace-pre-line text-slate-600">{v.notes}</p>
                  ) : null}
                  {v.attachments && v.attachments.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {v.attachments.map((a, i) => (
                        <a
                          key={i}
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 hover:bg-sky-100"
                        >
                          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                          </svg>
                          {a.name}
                        </a>
                      ))}
                    </div>
                  ) : null}
                  {/* Forward a correction-requested / rejected verdict to the
                      dealer. Primary → Step 2, co-borrower → Step 3. */}
                  {v.verdict === "queried" || v.verdict === "rejected" ? (
                    <div className="mt-2 border-t border-slate-100 pt-2">
                      {v.forwarded_at ? (
                        <ForwardedVerdictStatus
                          entry={
                            v.forwarded_request_id
                              ? wrapperById.get(v.forwarded_request_id)
                              : undefined
                          }
                          docFor={v.doc_for}
                          busy={busy}
                          rejectDrafts={childReject}
                          setRejectDrafts={setChildReject}
                          onReview={reviewChild}
                          sla={sla}
                          now={serverNow}
                        />
                      ) : (
                        <div className="space-y-1.5">
                          <textarea
                            value={verdictMsg[v.id] ?? ""}
                            onChange={(e) =>
                              setVerdictMsg((prev) => ({
                                ...prev,
                                [v.id]: e.target.value,
                              }))
                            }
                            rows={2}
                            placeholder="Message to the dealer — what the customer must correct/re-upload (required)…"
                            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                          />
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={
                                busy === `verdict-${v.id}` ||
                                !(verdictMsg[v.id] ?? "").trim()
                              }
                              onClick={() => forwardVerdict(v.id)}
                              className="rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {busy === `verdict-${v.id}`
                                ? "Forwarding…"
                                : "Forward to dealer"}
                            </button>
                            <span className="text-[11px] text-slate-500">
                              Goes to the dealer&apos;s{" "}
                              {v.doc_for === "co_borrower"
                                ? "Step 3 (co-borrower documents)"
                                : "Step 2 (customer documents)"}{" "}
                              with your message.
                            </span>
                          </div>
                        </div>
                      )}

                      {/* E-210 — or skip the dealer entirely: upload the
                          customer document yourself and send it to the NBFC. */}
                      <AdminReplyComposer
                        docFor={v.doc_for}
                        replies={repliesByVerdict.get(v.id) ?? []}
                        files={replyFiles[v.id] ?? []}
                        message={replyMsg[v.id] ?? ""}
                        resetKey={replyReset[v.id] ?? 0}
                        busy={busy === `reply-${v.id}`}
                        onFiles={(files) =>
                          setReplyFiles((prev) => ({ ...prev, [v.id]: files }))
                        }
                        onMessage={(m) =>
                          setReplyMsg((prev) => ({ ...prev, [v.id]: m }))
                        }
                        onSend={() => sendVerdictDocs(v.id)}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {standaloneThread.length > 0 ? (
        <ul className="space-y-3">
          {standaloneThread.map(({ request, items, messages }) => (
            <li
              key={request.id}
              className="rounded-lg border border-slate-200 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-slate-800 capitalize">
                    {request.dealer_direct
                      ? "Direct request to dealer"
                      : request.request_type.replace(/_/g, " ")}
                    {request.target_doc_key ? ` — ${request.target_doc_key}` : ""}
                    {/* E-240 — the admin is an observer on these, not a gate. */}
                    {request.dealer_direct ? (
                      <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700">
                        NBFC → Dealer
                      </span>
                    ) : null}
                  </p>
                  {request.nbfc_comments && !request.dealer_direct ? (
                    <p className="mt-0.5 whitespace-pre-line text-xs text-slate-600">
                      <LinkifiedText text={request.nbfc_comments} />
                    </p>
                  ) : null}
                  {request.request_type === "manual_consent" &&
                  firstUrl(request.nbfc_comments) ? (
                    <a
                      href={firstUrl(request.nbfc_comments) as string}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-flex items-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700 hover:bg-sky-100"
                    >
                      View uploaded consent document ↗
                    </a>
                  ) : null}
                  {/* E-210 — documents the admin attached to this message. */}
                  <AttachmentChips
                    attachments={request.attachments ?? []}
                    tone="emerald"
                  />
                </div>
                <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                  {/* E-254 — the SLA clock of the current leg, and who moved it. */}
                  {!request.dealer_direct &&
                  request.request_type !== "message" &&
                  (request.status === "nbfc_raised" || request.status === "admin_review") ? (
                    <SlaChip
                      dueAt={request.sla_due_at}
                      now={serverNow}
                      action="forward"
                      sla={sla}
                      legOn={!!sla?.autoForwardToDealer}
                    />
                  ) : null}
                  {!request.dealer_direct && request.status === "admin_review_upload" ? (
                    <SlaChip
                      dueAt={request.sla_due_at}
                      now={serverNow}
                      action="push"
                      sla={sla}
                      legOn={!!sla?.autoPushToNbfc}
                    />
                  ) : null}
                  {request.forward_source === "system" ? (
                    <AutoBadge kind="forwarded" at={request.auto_forwarded_at} />
                  ) : null}
                  {request.push_source === "system" &&
                  (request.status === "pushed_to_nbfc" || request.status === "closed") ? (
                    <AutoBadge kind="pushed" at={request.auto_pushed_at} />
                  ) : null}
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                    {STATUS_LABEL[request.status] ?? request.status}
                  </span>
                </span>
              </div>
              {request.sla_failure &&
              !request.dealer_direct &&
              (request.status === "nbfc_raised" ||
                request.status === "admin_review" ||
                request.status === "admin_review_upload") ? (
                <SlaFailure message={request.sla_failure} />
              ) : null}

              {items.length > 0 ? (
                <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-xs">
                  {items.map((it) => (
                    <li key={it.id} className="flex justify-between">
                      <span className="text-slate-600">{it.doc_label}</span>
                      <span className="text-slate-400">
                        {it.upload_status ?? "not_uploaded"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* E-240 — the NBFC ⇄ Dealer conversation, so the admin can read
                  what was asked and what came back without being in the loop. */}
              {(messages?.length ?? 0) > 0 ? (
                <ul className="mt-2 space-y-2 border-t border-slate-100 pt-2">
                  {(messages ?? []).map((m) => (
                    <li key={m.id}>
                      <div className="flex items-center gap-2">
                        <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold capitalize text-slate-600">
                          {m.party === "nbfc"
                            ? "NBFC"
                            : m.party === "dealer"
                              ? "Dealer"
                              : "Admin"}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {new Date(m.created_at).toLocaleString("en-IN", {
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      {m.message ? (
                        <p className="mt-1 whitespace-pre-line text-xs text-slate-600">
                          <LinkifiedText text={m.message} />
                        </p>
                      ) : null}
                      <AttachmentChips
                        attachments={m.attachments ?? []}
                        tone="sky"
                      />
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* Admin controls per hop. A direct request has no children to
                  forward and the dealer already has it, so forward/decline/push
                  would all be no-ops at best — the admin only watches. */}
              {request.request_type !== "message" && !request.dealer_direct ? (
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {(request.status === "nbfc_raised" ||
                    request.status === "admin_review") &&
                    request.request_type === "co_borrower" && (
                      <>
                        <button
                          type="button"
                          disabled={busy === request.id}
                          onClick={() => requestCoBorrower(request.id)}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 disabled:opacity-50"
                        >
                          {busy === request.id
                            ? "Requesting…"
                            : "Request co-borrower from dealer"}
                        </button>
                        <button
                          type="button"
                          disabled={busy === request.id}
                          onClick={() => simpleAction(request.id, "decline")}
                          className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 disabled:opacity-50"
                        >
                          Decline
                        </button>
                      </>
                    )}
                  {(request.status === "nbfc_raised" ||
                    request.status === "admin_review") &&
                    request.request_type !== "co_borrower" && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          const opening = forwardFor !== request.id;
                          setForwardFor(opening ? request.id : null);
                          if (opening) {
                            setForwardLabels(
                              request.request_type === "manual_consent"
                                ? "Customer-signed DPDP consent document"
                                : "",
                            );
                          }
                        }}
                        className="rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700"
                      >
                        Forward to dealer
                      </button>
                      <button
                        type="button"
                        disabled={busy === request.id}
                        onClick={() => simpleAction(request.id, "decline")}
                        className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 disabled:opacity-50"
                      >
                        Decline
                      </button>
                    </>
                  )}
                  {request.status === "admin_review_upload" && (
                    <button
                      type="button"
                      disabled={busy === request.id}
                      onClick={() => simpleAction(request.id, "push")}
                      className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 disabled:opacity-50"
                    >
                      Push to NBFC
                    </button>
                  )}
                </div>
              ) : null}

              {forwardFor === request.id ? (
                <div className="mt-2 rounded-md border border-slate-300 bg-slate-50 p-2.5">
                  <textarea
                    value={forwardLabels}
                    onChange={(e) => setForwardLabels(e.target.value)}
                    rows={2}
                    placeholder="Document labels to request (one per line, e.g. 'Updated bank statement')"
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    disabled={busy === request.id}
                    onClick={() => forward(request.id)}
                    className="mt-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    {busy === request.id ? "Forwarding…" : "Create request & forward"}
                  </button>
                </div>
              ) : null}

              <DirectMessage
                assignmentId={request.assignment_id}
                busy={busy === request.assignment_id}
                onSend={(m, files) =>
                  postMessage(request.assignment_id, m, files)
                }
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The × that collapses an open composer back to its "+ …" link. */
function CloseButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="-mr-0.5 -mt-0.5 shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
    >
      <svg
        className="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** File chips — used for both NBFC verdict attachments and admin uploads. */
function AttachmentChips({
  attachments,
  tone = "sky",
}: {
  attachments: VerdictAttachment[];
  tone?: "sky" | "emerald";
}) {
  if (attachments.length === 0) return null;
  const cls =
    tone === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
      : "border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100";
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {attachments.map((a, i) => (
        <a
          key={i}
          href={a.url}
          target="_blank"
          rel="noreferrer"
          className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium ${cls}`}
        >
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
          {a.name}
        </a>
      ))}
    </div>
  );
}

/**
 * E-210 — the admin's own document uploader for an NBFC verdict.
 *
 * When the admin already holds the corrected customer document there is no
 * reason to route the correction through the dealer: pick the file(s), write a
 * note, and it lands in the NBFC's request thread immediately. Sits alongside
 * "Forward to dealer" — either, both, or several sends over time are fine.
 */
function AdminReplyComposer({
  docFor,
  replies,
  files,
  message,
  resetKey,
  busy,
  onFiles,
  onMessage,
  onSend,
}: {
  docFor: string;
  replies: Entry[];
  files: File[];
  message: string;
  resetKey: number;
  busy: boolean;
  onFiles: (files: File[]) => void;
  onMessage: (message: string) => void;
  onSend: () => void;
}) {
  const [open, setOpen] = useState(false);
  const applicant = docFor === "co_borrower" ? "co-borrower's" : "customer's";

  return (
    <div className="mt-2 border-t border-slate-100 pt-2">
      {replies.length > 0 ? (
        <ul className="mb-2 space-y-1.5">
          {replies.map(({ request }) => (
            <li
              key={request.id}
              className="rounded-md border border-emerald-200 bg-emerald-50/60 px-2.5 py-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                  ✓ Sent to NBFC
                </span>
                <span className="text-[10px] text-slate-500">
                  {request.created_at
                    ? new Date(request.created_at).toLocaleString("en-IN")
                    : ""}
                </span>
              </div>
              {request.nbfc_comments ? (
                <p className="mt-0.5 whitespace-pre-line text-[11px] text-slate-600">
                  {request.nbfc_comments}
                </p>
              ) : null}
              <AttachmentChips
                attachments={request.attachments ?? []}
                tone="emerald"
              />
            </li>
          ))}
        </ul>
      ) : null}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[11px] font-semibold text-slate-500 hover:text-slate-700"
        >
          + Upload the {applicant} document and send it to the NBFC yourself
        </button>
      ) : (
        <div className="space-y-1.5 rounded-md border border-slate-300 bg-slate-50 p-2.5">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[11px] font-semibold text-slate-600">
              Send the document straight to the NBFC — no dealer round-trip.
            </p>
            {/* Minimise back to the "+ Upload…" link. The chosen files and the
                typed note are kept, so reopening resumes where you left off. */}
            <CloseButton
              label="Minimise the uploader"
              onClick={() => setOpen(false)}
            />
          </div>
          <input
            key={resetKey}
            type="file"
            multiple
            onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
            className="block w-full text-[11px] text-slate-600 file:mr-2 file:rounded-md file:border-0 file:bg-slate-200 file:px-2.5 file:py-1 file:text-[11px] file:font-semibold file:text-slate-700"
          />
          {files.length > 0 ? (
            <ul className="space-y-0.5">
              {files.map((f, i) => (
                <li key={i} className="text-[11px] text-slate-500">
                  {f.name}{" "}
                  <span className="text-slate-400">({formatBytes(f.size)})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[10px] text-slate-400">
              Up to 5 files, 15 MB each. Any format.
            </p>
          )}
          <textarea
            value={message}
            onChange={(e) => onMessage(e.target.value)}
            rows={2}
            placeholder="Message to the NBFC — what you are sending and why (required)…"
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || files.length === 0 || !message.trim()}
              onClick={onSend}
              className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send to NBFC"}
            </button>
            <span className="text-[11px] text-slate-500">
              Appears in the NBFC&apos;s request thread for this lead.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// Live status of a forwarded verdict: the wrapper's hop-status, the dealer's
// re-uploaded doc(s) with View + Approve/Reject, and a "sent back to NBFC" note
// once approved. Approving the last outstanding doc auto-pushes to the NBFC.
function ForwardedVerdictStatus({
  entry,
  docFor,
  busy,
  rejectDrafts,
  setRejectDrafts,
  onReview,
  sla,
  now,
}: {
  entry: Entry | undefined;
  docFor: string;
  busy: string | null;
  rejectDrafts: Record<string, string>;
  setRejectDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  onReview: (childId: string, action: "approve" | "reject") => void;
  /** E-254 */
  sla?: SlaInfo | null;
  now?: number;
}) {
  const stepLabel = docFor === "co_borrower" ? "Step 3" : "Step 2";

  // Fallback while the thread hasn't loaded / linked wrapper not found.
  if (!entry) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
        Forwarded to dealer · {stepLabel}
      </span>
    );
  }

  const status = entry.request.status;
  const pushed = status === "pushed_to_nbfc" || status === "closed";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700">
          Forwarded · {stepLabel}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            pushed
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-slate-200 bg-slate-50 text-slate-600"
          }`}
        >
          {STATUS_LABEL[status] ?? status}
        </span>
        {/* E-254 — leg-2 clock while the uploads wait on the admin; provenance after. */}
        {status === "admin_review_upload" && now !== undefined ? (
          <SlaChip
            dueAt={entry.request.sla_due_at}
            now={now}
            action="push"
            sla={sla ?? null}
            legOn={!!sla?.autoPushToNbfc}
          />
        ) : null}
        {pushed && entry.request.push_source === "system" ? (
          <AutoBadge kind="pushed" at={entry.request.auto_pushed_at} />
        ) : null}
      </div>
      {entry.request.sla_failure && status === "admin_review_upload" ? (
        <SlaFailure message={entry.request.sla_failure} />
      ) : null}

      {entry.items.map((it) => {
        const st = it.upload_status ?? "not_uploaded";
        const tone =
          st === "verified"
            ? "border-emerald-200 bg-emerald-50"
            : st === "rejected"
              ? "border-rose-200 bg-rose-50"
              : st === "uploaded"
                ? "border-amber-200 bg-amber-50"
                : "border-slate-200 bg-white";
        const stLabel =
          st === "verified"
            ? "Verified"
            : st === "rejected"
              ? "Rejected — back with dealer"
              : st === "uploaded"
                ? "Uploaded — review"
                : "Awaiting dealer upload";
        const childBusy = busy === `child-${it.id}`;
        return (
          <div key={it.id} className={`rounded-md border ${tone} p-2`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-700">
                {it.doc_label}
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {stLabel}
              </span>
            </div>
            {it.rejection_reason ? (
              <p className="mt-0.5 text-[11px] text-rose-700">
                {it.rejection_reason}
              </p>
            ) : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {it.file_url ? (
                <a
                  href={it.file_url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                >
                  View
                </a>
              ) : null}
              {st === "uploaded" ? (
                <>
                  <button
                    type="button"
                    disabled={childBusy}
                    onClick={() => onReview(it.id, "approve")}
                    className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 disabled:opacity-50"
                  >
                    {childBusy ? "Approving…" : "Approve"}
                  </button>
                  <input
                    value={rejectDrafts[it.id] ?? ""}
                    onChange={(e) =>
                      setRejectDrafts((prev) => ({
                        ...prev,
                        [it.id]: e.target.value,
                      }))
                    }
                    placeholder="Rejection reason…"
                    className="min-w-[10rem] flex-1 rounded-md border border-slate-300 px-2 py-1 text-[11px]"
                  />
                  <button
                    type="button"
                    disabled={childBusy || !(rejectDrafts[it.id] ?? "").trim()}
                    onClick={() => onReview(it.id, "reject")}
                    className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700 disabled:opacity-50"
                  >
                    Reject
                  </button>
                </>
              ) : null}
            </div>
          </div>
        );
      })}

      {pushed ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
          ✓ Sent back to NBFC
        </span>
      ) : null}
    </div>
  );
}

function DirectMessage({
  assignmentId,
  busy,
  onSend,
}: {
  assignmentId: string;
  busy: boolean;
  onSend: (message: string, files: File[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  void assignmentId;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 text-xs font-medium text-slate-500 hover:text-slate-700"
      >
        + Message the NBFC directly
      </button>
    );
  }
  return (
    <div className="mt-2 space-y-1.5 rounded-md border border-slate-200 bg-slate-50 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-semibold text-slate-600">
          Message the NBFC directly
        </p>
        {/* Minimise — the typed note and any attached files are kept. */}
        <CloseButton
          label="Minimise the message box"
          onClick={() => setOpen(false)}
        />
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          rows={2}
          placeholder="Post an update straight to the NBFC (no dealer round-trip)…"
          className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        <button
          type="button"
          disabled={busy || !msg.trim()}
          onClick={() => {
            onSend(msg, files);
            setMsg("");
            setFiles([]);
            setOpen(false);
          }}
          className="rounded-md bg-[color:var(--color-brand-navy,#1e3a5f)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          Send
        </button>
      </div>
      {/* E-210 — attach customer documents to the message. */}
      <input
        type="file"
        multiple
        onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        className="block w-full text-[11px] text-slate-600 file:mr-2 file:rounded-md file:border-0 file:bg-slate-200 file:px-2.5 file:py-1 file:text-[11px] file:font-semibold file:text-slate-700"
      />
      <p className="text-[10px] text-slate-400">
        {files.length > 0
          ? `${files.length} file(s) attached: ${files.map((f) => f.name).join(", ")}`
          : "Optionally attach documents (up to 5 files, 15 MB each)."}
      </p>
    </div>
  );
}
