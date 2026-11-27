"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { fmtDate, json, liFetch } from "./api";

type Conv = {
  id: string;
  unread: boolean;
  sentiment: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  last_body: string | null;
  meeting?: boolean;
  meeting_hint?: boolean;
  prospect: { id: string; full_name: string | null; headline: string | null; company: string | null; public_url: string; do_not_contact: boolean } | null;
};
type Thread = {
  conversation: Conv;
  meeting: { meeting: boolean; hint: boolean };
  prospect: { full_name: string | null; headline: string | null; company: string | null; public_url: string; do_not_contact: boolean; lead_id: string | null } | null;
  messages: { id: string; direction: string; body: string | null; attachment_name: string | null; sent_at: string; seen_at: string | null }[];
  outbox: { id: string; body: string; status: string; error: string | null; created_at: string }[];
};

const SENTIMENT_TONE: Record<string, string> = {
  positive: "bg-green-50 text-green-700",
  neutral: "bg-gray-100 text-gray-600",
  negative: "bg-red-50 text-red-700",
};

export function InboxView() {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [attachment, setAttachment] = useState<{ id: string; file_name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["li-inbox"], queryFn: () => liFetch<Conv[]>("/api/linkedin/inbox"), refetchInterval: 60_000 });
  useEffect(() => {
    if (!openId && list.data?.[0]) setOpenId(list.data[0].id);
  }, [list.data, openId]);

  const thread = useQuery({
    queryKey: ["li-thread", openId],
    enabled: !!openId,
    queryFn: () => liFetch<Thread>(`/api/linkedin/inbox/${openId}`),
    refetchInterval: 30_000,
  });

  async function draft() {
    if (!openId) return;
    setBusy("draft");
    try {
      const r = await liFetch<{ draft: string; sentiment: string | null; meeting_hint?: boolean }>(`/api/linkedin/inbox/${openId}/draft`, {
        method: "POST",
      });
      setReply(r.draft);
      toast.success("Draft ready — edit it, then press Send");
      await Promise.all([qc.invalidateQueries({ queryKey: ["li-inbox"] }), r.meeting_hint ? thread.refetch() : null]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No draft");
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    if (!openId || !reply.trim()) return;
    setBusy("send");
    try {
      await liFetch(`/api/linkedin/inbox/${openId}/reply`, { method: "POST", ...json({ body: reply, attachment_id: attachment?.id ?? null }) });
      setReply("");
      setAttachment(null);
      toast.success("Queued — it goes out on the next paced slot");
      await thread.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setBusy(null);
    }
  }

  /** E-398: the Meetings KPI counts this button only — never the AI hint. */
  async function meeting(body: { meeting: boolean } | { dismiss_hint: true }) {
    if (!openId) return;
    setBusy("meeting");
    try {
      await liFetch(`/api/linkedin/inbox/${openId}/meeting`, { method: "POST", ...json(body) });
      if ("meeting" in body) toast.success(body.meeting ? "Meeting scheduled — counted on Analytics" : "Meeting cleared");
      await Promise.all([thread.refetch(), qc.invalidateQueries({ queryKey: ["li-inbox"] })]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    if (!openId || !window.confirm("Stop contacting this person in every campaign?")) return;
    setBusy("stop");
    try {
      await liFetch(`/api/linkedin/inbox/${openId}/stop`, { method: "POST" });
      toast.success("Marked do-not-contact");
      await Promise.all([thread.refetch(), qc.invalidateQueries({ queryKey: ["li-inbox"] })]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File) {
    const fd = new FormData();
    fd.set("file", file);
    try {
      setAttachment(await liFetch<{ id: string; file_name: string }>("/api/linkedin/attachments", { method: "POST", body: fd }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    }
  }

  const t = thread.data;
  return (
    <div className="grid min-h-[600px] gap-4 lg:grid-cols-[340px_1fr]">
      <aside className="rounded-lg border border-gray-200 bg-white">
        <h2 className="border-b border-gray-100 px-3 py-2 text-sm font-semibold text-gray-800">Conversations (replies first)</h2>
        <ul className="max-h-[720px] divide-y divide-gray-100 overflow-y-auto">
          {(list.data ?? []).map((c) => (
            <li key={c.id}>
              <button
                onClick={() => {
                  setOpenId(c.id);
                  setReply("");
                }}
                className={`w-full px-3 py-2 text-left hover:bg-gray-50 ${c.id === openId ? "bg-blue-50" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`truncate text-sm ${c.unread ? "font-semibold text-gray-900" : "text-gray-800"}`}>
                    {c.prospect?.full_name ?? "Unknown"}
                  </span>
                  <span className="flex shrink-0 gap-1">
                    {c.meeting && <span className="rounded-full bg-indigo-50 px-1.5 text-[10px] text-indigo-700">meeting</span>}
                    {!c.meeting && c.meeting_hint && <span className="rounded-full bg-amber-50 px-1.5 text-[10px] text-amber-700">meeting?</span>}
                    {c.sentiment && <span className={`rounded-full px-1.5 text-[10px] ${SENTIMENT_TONE[c.sentiment] ?? ""}`}>{c.sentiment}</span>}
                  </span>
                </div>
                <div className="truncate text-xs text-gray-500">{c.last_body ?? ""}</div>
                <div className="text-[10px] text-gray-400">{fmtDate(c.last_message_at)}</div>
              </button>
            </li>
          ))}
          {list.isSuccess && !list.data.length && (
            <li className="px-3 py-6 text-sm text-gray-500">No conversations yet. Replies appear here after the next poll.</li>
          )}
          {list.isError && <li className="px-3 py-6 text-sm text-red-600">{(list.error as Error).message}</li>}
        </ul>
      </aside>

      <section className="flex flex-col rounded-lg border border-gray-200 bg-white">
        {!t ? (
          <p className="p-6 text-sm text-gray-500">{openId ? "Loading…" : "Pick a conversation."}</p>
        ) : (
          <>
            <div className="flex items-start justify-between border-b border-gray-100 px-4 py-3">
              <div>
                <a href={t.prospect?.public_url} target="_blank" rel="noreferrer" className="font-semibold text-blue-700 hover:underline">
                  {t.prospect?.full_name ?? "Unknown"}
                </a>
                <div className="text-xs text-gray-500">
                  {[t.prospect?.headline, t.prospect?.company].filter(Boolean).join(" · ")}
                  {t.prospect?.lead_id && <> · CRM lead {t.prospect.lead_id}</>}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {t.meeting.meeting ? (
                  <button
                    disabled={!!busy}
                    onClick={() => meeting({ meeting: false })}
                    className="rounded-md border border-indigo-300 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700"
                    title="Click to clear"
                  >
                    ✓ Meeting scheduled
                  </button>
                ) : (
                  <button
                    disabled={!!busy}
                    onClick={() => meeting({ meeting: true })}
                    className="rounded-md border border-indigo-300 px-3 py-1 text-xs text-indigo-700 hover:bg-indigo-50"
                  >
                    Mark meeting scheduled
                  </button>
                )}
                {t.prospect && !t.prospect.do_not_contact ? (
                  <button disabled={!!busy} onClick={stop} className="rounded-md border border-red-300 px-3 py-1 text-xs text-red-700">
                    Stop contacting
                  </button>
                ) : (
                  <span className="text-xs text-red-600">Do not contact</span>
                )}
              </div>
            </div>
            {t.meeting.hint && !t.meeting.meeting && (
              <div className="flex flex-wrap items-center gap-2 border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                Looks like a call or meeting was agreed in this chat. Mark it so it counts on Analytics?
                <button disabled={!!busy} onClick={() => meeting({ meeting: true })} className="rounded border border-amber-300 bg-white px-2 py-0.5 font-medium">
                  Yes, mark it
                </button>
                <button disabled={!!busy} onClick={() => meeting({ dismiss_hint: true })} className="underline">
                  Not a meeting
                </button>
              </div>
            )}
            <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
              {t.messages.map((m) => (
                <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${m.direction === "out" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-900"}`}>
                    <p className="whitespace-pre-wrap">{m.body}</p>
                    {m.attachment_name && <p className="mt-1 text-xs opacity-80">📎 {m.attachment_name}</p>}
                    <p className="mt-1 text-[10px] opacity-70">
                      {fmtDate(m.sent_at)}
                      {m.direction === "out" && (m.seen_at ? " · Seen" : " · Sent")}
                    </p>
                  </div>
                </div>
              ))}
              {t.outbox.map((o) => (
                <div key={o.id} className="flex justify-end">
                  <div className="max-w-[75%] rounded-lg border border-dashed border-blue-300 px-3 py-2 text-sm text-gray-700">
                    <p className="whitespace-pre-wrap">{o.body}</p>
                    <p className="mt-1 text-[10px] text-gray-500">{o.status === "failed" ? `Failed: ${o.error}` : "Queued — waiting for the next paced slot"}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-2 border-t border-gray-100 p-3">
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={4}
                placeholder="Type a reply, or ask for a suggested draft"
                disabled={!!t.prospect?.do_not_contact}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button disabled={!!busy} onClick={draft} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm">
                  {busy === "draft" ? "Drafting…" : "Suggest a reply"}
                </button>
                {attachment ? (
                  <span className="text-xs text-gray-700">
                    📎 {attachment.file_name}{" "}
                    <button onClick={() => setAttachment(null)} className="text-red-600">
                      ×
                    </button>
                  </span>
                ) : (
                  <input type="file" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} className="text-xs" />
                )}
                <button
                  disabled={!!busy || !reply.trim() || !!t.prospect?.do_not_contact}
                  onClick={send}
                  className="ml-auto rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy === "send" ? "Queuing…" : "Send"}
                </button>
              </div>
              <p className="text-[11px] text-gray-500">Drafts are never sent on their own. Pressing Send is your approval.</p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
