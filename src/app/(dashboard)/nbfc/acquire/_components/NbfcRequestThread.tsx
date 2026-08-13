"use client";

import { useCallback, useEffect, useState } from "react";

// The NBFC's request/message thread for a lead (Changes 2 & 3, NBFC view). Shows
// every request the NBFC raised + every admin message, each with its current hop
// status and any linked documents. When a request is pushed back, the NBFC can
// acknowledge it to close the thread.

interface ThreadItem {
  id: string;
  doc_label: string;
  upload_status: string | null;
  file_url: string | null;
}
interface Attachment {
  url: string;
  name: string;
  type: string;
  size: number;
}
interface ThreadRequest {
  id: string;
  request_type: string;
  status: string;
  nbfc_comments: string | null;
  admin_notes: string | null;
  // E-210 — documents the iTarang admin uploaded and sent with this message.
  attachments: Attachment[] | null;
  // E-240 — TRUE when this request went straight to the dealer.
  dealer_direct?: boolean | null;
  created_at: string;
}
// E-240 — one turn of the NBFC ⇄ Dealer conversation.
interface ThreadMessage {
  id: string;
  party: string;
  message: string | null;
  attachments: Attachment[] | null;
  created_at: string;
}
interface ThreadEntry {
  request: ThreadRequest;
  items: ThreadItem[];
  messages?: ThreadMessage[];
}

const STATUS_STYLE: Record<string, string> = {
  nbfc_raised: "bg-sky-50 text-sky-700 border-sky-200",
  admin_review: "bg-amber-50 text-amber-700 border-amber-200",
  forwarded_to_dealer: "bg-amber-50 text-amber-700 border-amber-200",
  with_customer: "bg-amber-50 text-amber-700 border-amber-200",
  dealer_review: "bg-amber-50 text-amber-700 border-amber-200",
  admin_review_upload: "bg-indigo-50 text-indigo-700 border-indigo-200",
  pushed_to_nbfc: "bg-emerald-50 text-emerald-700 border-emerald-200",
  closed: "bg-slate-100 text-slate-500 border-slate-200",
  rejected: "bg-rose-50 text-rose-700 border-rose-200",
};
const STATUS_LABEL: Record<string, string> = {
  nbfc_raised: "Raised — with admin",
  admin_review: "With admin",
  forwarded_to_dealer: "Forwarded to dealer",
  with_customer: "Collecting from customer",
  dealer_review: "Dealer reviewing",
  admin_review_upload: "Admin reviewing upload",
  pushed_to_nbfc: "Updated — ready",
  closed: "Closed",
  rejected: "Declined by admin",
};
const TYPE_LABEL: Record<string, string> = {
  correction: "Correction request",
  additional_docs: "Additional documents",
  step4_extra_items: "Extra Step-4 items",
  manual_consent: "Manual DPDP consent",
  message: "Message from admin",
};

// E-240 — a direct request walks the same statuses but means something else at
// each stop (there is no admin in the middle), so it needs its own copy.
const DIRECT_STATUS_LABEL: Record<string, string> = {
  forwarded_to_dealer: "Sent to dealer",
  with_customer: "Sent to dealer",
  dealer_review: "Sent to dealer",
  pushed_to_nbfc: "Dealer replied",
  closed: "Closed",
  rejected: "Declined",
};
const PARTY_STYLE: Record<string, string> = {
  nbfc: "bg-sky-50 text-sky-700 border-sky-200",
  dealer: "bg-amber-50 text-amber-700 border-amber-200",
  admin: "bg-slate-100 text-slate-600 border-slate-200",
};
const PARTY_LABEL: Record<string, string> = {
  nbfc: "You",
  dealer: "Dealer",
  admin: "iTarang admin",
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** Attachment chips — same markup the admin-attachment list uses. */
function AttachmentChips({ files }: { files: Attachment[] }) {
  if (files.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {files.map((a, i) => (
        <a
          key={`${a.url}-${i}`}
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
  );
}

// Linkify any http(s) URL embedded in the free-text comments (the manual-consent
// wrapper carries the uploaded consent-document URL inline as "Document: <url>").
const URL_RE = /(https?:\/\/[^\s]+)/g;
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

export default function NbfcRequestThread({
  leadId,
  refreshSignal = 0,
}: {
  leadId: string;
  refreshSignal?: number;
}) {
  const [entries, setEntries] = useState<ThreadEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [acking, setAcking] = useState<string | null>(null);
  // E-240 — per-thread reply composer (only on direct threads).
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replying, setReplying] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/nbfc/acquire/${leadId}/doc-requests`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (json.ok) setEntries(json.thread ?? []);
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load, refreshSignal]);

  const acknowledge = async (id: string) => {
    setAcking(id);
    try {
      await fetch(`/api/nbfc/acquire/${leadId}/doc-requests/${id}/ack`, {
        method: "POST",
      });
      await load();
    } finally {
      setAcking(null);
    }
  };

  // E-240 — write back to the dealer on a direct thread.
  const sendReply = async (id: string) => {
    const message = replyText.trim();
    if (!message) return;
    setReplying(true);
    setReplyError(null);
    try {
      const res = await fetch(
        `/api/nbfc/acquire/${leadId}/doc-requests/${id}/reply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        },
      );
      const json = await res.json();
      if (json.ok) {
        setReplyFor(null);
        setReplyText("");
        await load();
      } else {
        setReplyError(json.error ?? "Could not send");
      }
    } catch {
      setReplyError("Network error. Please try again.");
    } finally {
      setReplying(false);
    }
  };

  if (loading) {
    return <p className="text-sm text-slate-400">Loading request history…</p>;
  }
  if (entries.length === 0) {
    return (
      <p className="text-sm text-slate-400">
        No requests yet. Use <em>Ask Dealer for Documents</em> above to message
        the dealer directly, or the other buttons to route a correction /
        co-borrower request through the iTarang admin.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {entries.map(({ request, items, messages }) => {
        const direct = !!request.dealer_direct;
        const msgs = messages ?? [];
        return (
        <li
          key={request.id}
          className="rounded-lg border border-slate-200 bg-white p-3.5"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-800">
                {direct
                  ? "Direct request to dealer"
                  : request.request_type === "message" &&
                      (request.attachments?.length ?? 0) > 0
                    ? "Document from admin"
                    : (TYPE_LABEL[request.request_type] ?? request.request_type)}
              </p>
              {/* On a direct thread the opening ask is message #1, so rendering
                  nbfc_comments here too would print it twice. */}
              {request.nbfc_comments && !direct ? (
                <p className="mt-0.5 whitespace-pre-line text-xs text-slate-600">
                  <LinkifiedText text={request.nbfc_comments} />
                </p>
              ) : null}
              {request.admin_notes ? (
                <p className="mt-0.5 text-xs text-slate-500">
                  <span className="font-medium">Admin:</span> {request.admin_notes}
                </p>
              ) : null}
              {/* E-210 — files the admin uploaded for this lead. Served by the
                  authenticated /api/nbfc-uploads route. */}
              {request.attachments && request.attachments.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {request.attachments.map((a, i) => (
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
            </div>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                STATUS_STYLE[request.status] ??
                "bg-slate-100 text-slate-600 border-slate-200"
              }`}
            >
              {(direct
                ? DIRECT_STATUS_LABEL[request.status]
                : STATUS_LABEL[request.status]) ?? request.status}
            </span>
          </div>

          {/* E-240 — the NBFC ⇄ Dealer conversation. */}
          {msgs.length > 0 ? (
            <ul className="mt-2.5 space-y-2 border-t border-slate-100 pt-2.5">
              {msgs.map((m) => (
                <li key={m.id}>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                        PARTY_STYLE[m.party] ??
                        "bg-slate-100 text-slate-600 border-slate-200"
                      }`}
                    >
                      {PARTY_LABEL[m.party] ?? m.party}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {formatWhen(m.created_at)}
                    </span>
                  </div>
                  {m.message ? (
                    <p className="mt-1 whitespace-pre-line text-xs text-slate-600">
                      <LinkifiedText text={m.message} />
                    </p>
                  ) : null}
                  <AttachmentChips files={m.attachments ?? []} />
                </li>
              ))}
            </ul>
          ) : null}

          {items.length > 0 ? (
            <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2">
              {items.map((it) => (
                <li
                  key={it.id}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="text-slate-600">{it.doc_label}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-slate-400">
                      {it.upload_status ?? "not_uploaded"}
                    </span>
                    {it.file_url && request.status === "pushed_to_nbfc" ? (
                      <a
                        href={it.file_url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-[color:var(--color-brand-sky)] hover:underline"
                      >
                        View
                      </a>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-2 flex flex-wrap gap-2">
            {request.status === "pushed_to_nbfc" ? (
              <button
                type="button"
                onClick={() => acknowledge(request.id)}
                disabled={acking === request.id}
                className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
              >
                {acking === request.id
                  ? "…"
                  : request.request_type === "manual_consent"
                    ? "Verify & close"
                    : "Acknowledge & close"}
              </button>
            ) : null}
            {/* E-240 — write back to the dealer while the thread is open. */}
            {direct && request.status !== "closed" && replyFor !== request.id ? (
              <button
                type="button"
                onClick={() => {
                  setReplyFor(request.id);
                  setReplyText("");
                  setReplyError(null);
                }}
                className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Reply to dealer
              </button>
            ) : null}
          </div>

          {direct && replyFor === request.id ? (
            <div className="mt-2 rounded-lg border border-slate-300 bg-slate-50 p-2.5">
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                rows={3}
                placeholder="Clarify what you need, or tell the dealer what was wrong with the last file…"
                className="w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm"
              />
              {replyError ? (
                <p className="mt-1 text-[11px] text-rose-600">{replyError}</p>
              ) : null}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={replying || !replyText.trim()}
                  onClick={() => sendReply(request.id)}
                  className="rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  {replying ? "Sending…" : "Send to dealer"}
                </button>
                <button
                  type="button"
                  onClick={() => setReplyFor(null)}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </li>
        );
      })}
    </ul>
  );
}
