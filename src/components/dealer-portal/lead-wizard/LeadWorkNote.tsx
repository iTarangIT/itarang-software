"use client";

// ID 183 (21 Oct) — the dealer portal's side of "iTarang works a file".
//
//   Dealer (the file's owner): sees "Being worked by <name> (iTarang) until
//   hh:mm" while Admin / Sales Head or the house login holds the 30-minute
//   note. Before, only the CRM "Act for dealer" panel showed it.
//
//   House login on a file it pushed out: works the file here like the dealer,
//   so its saves get the same "dealer wins" check as the CRM panel — every
//   write this page makes to the file's step routes carries the dealer's last
//   action as of page load (x-seen-dealer-action-at); a save made after the
//   dealer acted is refused, and the strip offers a reload.
//
// Renders nothing when there is nothing to say, or for a login the API
// refuses (403).

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, RefreshCw } from "lucide-react";

import { carriesSeenHeader } from "@/lib/leads/actForDealer";

interface WorkNote {
  kind: "dealer" | "house" | "itarang";
  text: string | null;
  mine: boolean;
  dealerLastActionAt: string | null;
  seenHeader: string;
}

const POLL_MS = 60_000;

export default function LeadWorkNote({ leadId }: { leadId: string }) {
  const [note, setNote] = useState<WorkNote | null>(null);
  /** The dealer's last action when this page loaded — what the house login's saves send back. */
  const seenRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/lead/${encodeURIComponent(leadId)}/work-note`, { cache: "no-store" });
      if (!res.ok) return setNote(null);
      const json = await res.json();
      if (!json?.success) return setNote(null);
      const data = json.data as WorkNote;
      if (seenRef.current === null) seenRef.current = data.dealerLastActionAt ?? "none";
      setNote(data);
    } catch {
      /* keep what is shown */
    }
  }, [leadId]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const isHouse = note?.kind === "house";
  const header = note?.seenHeader;

  // The house login's saves on this file carry the dealer's last action as of page load.
  useEffect(() => {
    if (!isHouse || !header || seenRef.current === null) return;
    const seen = seenRef.current;
    const original = window.fetch;
    const patched: typeof window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (!carriesSeenHeader(url, method, leadId)) return original(input, init);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (!headers.has(header)) headers.set(header, seen);
      return original(input, { ...init, headers });
    };
    window.fetch = patched;
    return () => {
      if (window.fetch === patched) window.fetch = original;
    };
  }, [isHouse, header, leadId]);

  if (!note) return null;
  const dealerMovedOn =
    isHouse && seenRef.current !== null && (note.dealerLastActionAt ?? "none") !== seenRef.current;
  if (!note.text && !dealerMovedOn) return null;

  return (
    <div
      className={`mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-2.5 text-sm ${
        note.mine ? "border-indigo-200 bg-indigo-50 text-indigo-800" : "border-amber-200 bg-amber-50 text-amber-900"
      }`}
    >
      <div className="space-y-0.5">
        {note.text && (
          <div className="flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5 shrink-0" />
            <span>{note.text}</span>
          </div>
        )}
        {dealerMovedOn && (
          <div>The dealer worked on this file after you opened it. Reload to see their changes before you save.</div>
        )}
      </div>
      {dealerMovedOn && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Reload
        </button>
      )}
    </div>
  );
}
