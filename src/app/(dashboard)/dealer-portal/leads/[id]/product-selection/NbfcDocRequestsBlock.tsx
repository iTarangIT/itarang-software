"use client";

/**
 * NBFC document requests — E-240, dealer side.
 *
 * The lender can now ask the dealer for a specific document DIRECTLY, without
 * waiting for an iTarang admin to forward it. Those asks land here, inside the
 * Step-4 "Pre-sanction documents" card, because that is where the dealer already
 * has an upload control and the lender's whole reason for asking is to get a
 * file attached to this lead — putting the question anywhere else would mean
 * reading it in one place and answering it in another.
 *
 * The dealer answers in one action: attach files, write a note, or both. Files
 * go through the SAME /api/lead/[id]/pre-sanction-doc upload the surrounding
 * card uses (so storage, the 50 MB cap and combine-to-PDF are shared), then the
 * reply route stores them on the message and mirrors them into the bucket.
 *
 * Self-hides when there is nothing open, so the card looks exactly as it does
 * today until a lender actually asks for something.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, Paperclip, RefreshCw, X } from "lucide-react";

/** Matches FinancingOffersSection: refresh while the tab is visible. */
const POLL_MS = 30_000;

interface Attachment {
  url: string;
  name: string;
  type: string;
  size: number;
}
interface Message {
  id: string;
  party: string;
  message: string | null;
  attachments: Attachment[];
  created_at: string;
}
interface DealerRequest {
  id: string;
  nbfcName: string;
  status: string;
  doc_for: string;
  created_at: string;
  messages: Message[];
}

const PARTY_STYLE: Record<string, string> = {
  nbfc: "border-sky-200 bg-sky-50 text-sky-700",
  dealer: "border-teal-200 bg-teal-50 text-teal-700",
  admin: "border-slate-200 bg-slate-100 text-slate-600",
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

export default function NbfcDocRequestsBlock({
  leadId,
  onDocsMirrored,
}: {
  leadId: string;
  /**
   * Fires with the new pre-sanction bucket when a reply's files were mirrored
   * into it, so the list rendered below this block stays in step without a
   * reload. Omitted when the bucket was full or no selection row exists yet.
   */
  onDocsMirrored?: (items: Attachment[]) => void;
}) {
  const [requests, setRequests] = useState<DealerRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Don't clobber a half-written reply with a poll result.
  const dirtyRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/lead/${leadId}/nbfc-requests`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (json.ok) setRequests(json.requests ?? []);
    } catch {
      // best-effort — the card simply shows nothing new this tick.
    } finally {
      setLoaded(true);
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible" && !dirtyRef.current) void load();
    };
    const timer = setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  const openReply = (id: string) => {
    setOpenFor(id);
    setNote("");
    setPending([]);
    setError(null);
    dirtyRef.current = true;
  };

  const closeReply = () => {
    setOpenFor(null);
    setNote("");
    setPending([]);
    setError(null);
    dirtyRef.current = false;
  };

  // Reuses the Step-4 upload endpoint, so a lender-requested file takes exactly
  // the same path (and the same 50 MB / combine rules) as any pre-sanction doc.
  const attach = async (fileList: FileList, mode: "separate" | "combine") => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      fd.append("mode", mode);
      const res = await fetch(`/api/lead/${leadId}/pre-sanction-doc`, {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json?.error || "Upload failed");
      setPending((prev) => [...prev, ...(json.items as Attachment[])]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const send = async (id: string) => {
    if (!note.trim() && pending.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/lead/${leadId}/nbfc-requests/${id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: note.trim(), items: pending }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json?.error || "Could not send");
      if (json.mirrored && Array.isArray(json.bucket)) {
        onDocsMirrored?.(json.bucket as Attachment[]);
      }
      closeReply();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send");
    } finally {
      setSending(false);
    }
  };

  if (!loaded || requests.length === 0) return null;

  return (
    <div id="nbfc-requests" className="mb-4 scroll-mt-24 space-y-3">
      {requests.map((r) => {
        const answered = r.status === "pushed_to_nbfc";
        return (
          <div
            key={r.id}
            className={`rounded-xl border p-3.5 ${
              answered
                ? "border-slate-200 bg-slate-50"
                : "border-sky-300 bg-sky-50/60"
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-start gap-2">
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
                <div>
                  <p className="text-sm font-semibold text-slate-800">
                    {r.nbfcName} needs a document
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Requested {formatWhen(r.created_at)}
                    {r.doc_for === "co_borrower" ? " · for the co-borrower" : ""}
                  </p>
                </div>
              </div>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  answered
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-amber-200 bg-amber-50 text-amber-700"
                }`}
              >
                {answered ? "Sent — awaiting lender" : "Action needed"}
              </span>
            </div>

            {/* The conversation so far. */}
            <ul className="mt-2.5 space-y-2 border-t border-slate-200/70 pt-2.5">
              {r.messages.map((m) => (
                <li key={m.id}>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                        PARTY_STYLE[m.party] ??
                        "border-slate-200 bg-slate-100 text-slate-600"
                      }`}
                    >
                      {m.party === "nbfc"
                        ? r.nbfcName
                        : m.party === "dealer"
                          ? "You"
                          : "iTarang admin"}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {formatWhen(m.created_at)}
                    </span>
                  </div>
                  {m.message ? (
                    <p className="mt-1 whitespace-pre-line text-xs text-slate-700">
                      {m.message}
                    </p>
                  ) : null}
                  {m.attachments.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {m.attachments.map((a, i) => (
                        <a
                          key={`${a.url}-${i}`}
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded border border-teal-200 bg-white px-2 py-0.5 text-[11px] font-medium text-teal-700 hover:bg-teal-50"
                        >
                          <Paperclip className="h-3 w-3" />
                          {a.name}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>

            {openFor === r.id ? (
              <div className="mt-3 rounded-lg border border-slate-300 bg-white p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <label
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 ${
                      uploading ? "pointer-events-none opacity-50" : ""
                    }`}
                  >
                    <Paperclip className="h-3.5 w-3.5" />
                    Attach documents
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      disabled={uploading}
                      onChange={(e) => {
                        if (e.target.files?.length) void attach(e.target.files, "separate");
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <label
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-teal-300 bg-teal-50 px-3 py-1.5 text-xs font-semibold text-teal-700 hover:bg-teal-100 ${
                      uploading ? "pointer-events-none opacity-50" : ""
                    }`}
                  >
                    <Paperclip className="h-3.5 w-3.5" />
                    Combine as one PDF
                    <input
                      type="file"
                      multiple
                      accept="image/*,application/pdf"
                      className="hidden"
                      disabled={uploading}
                      onChange={(e) => {
                        if (e.target.files?.length) void attach(e.target.files, "combine");
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {uploading ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Uploading…
                    </span>
                  ) : null}
                </div>

                {pending.length > 0 ? (
                  <ul className="mb-2 space-y-1">
                    {pending.map((p, i) => (
                      <li
                        key={`${p.url}-${i}`}
                        className="flex items-center justify-between gap-2 rounded border border-slate-200 px-2 py-1"
                      >
                        <span className="min-w-0 flex-1 truncate text-xs text-slate-700">
                          {p.name}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setPending((prev) => prev.filter((_, idx) => idx !== i))
                          }
                          className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-rose-600"
                          aria-label="Remove"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder={`Message to ${r.nbfcName} (optional)…`}
                  className="w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm"
                />

                {error ? (
                  <p className="mt-1.5 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
                    {error}
                  </p>
                ) : null}

                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={sending || uploading || (!note.trim() && pending.length === 0)}
                    onClick={() => void send(r.id)}
                    className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                  >
                    {sending ? "Sending…" : "Send to lender"}
                  </button>
                  <button
                    type="button"
                    onClick={closeReply}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => openReply(r.id)}
                className="mt-3 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700"
              >
                {answered ? "Send more" : "Reply with document"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
