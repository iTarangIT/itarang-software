"use client";

/**
 * The buyback notification bell (items 12/13).
 *
 * Replaces a decorative one: the header's bell was a <button> with no onClick
 * and a hardcoded red dot — permanently lit, so it conveyed nothing. Meanwhile
 * 997 notifications sat unread on db-1, including 6 escalations, because nothing
 * in the product could read them.
 *
 * POLLING, NOT REALTIME, and not by preference. The buyback tables are on AWS
 * RDS; Supabase here is auth-only, so Supabase Realtime cannot see them. There
 * is no websocket path and no react-query. The interval is deliberately slow —
 * the RDS instance has ~79 max_connections and NO pooler (src/lib/db/index.ts),
 * so a fast poll times three roles times N open tabs is a self-inflicted
 * outage, and this is a bell, not a trading screen.
 *
 * Refetches on window focus, which is when a human actually looks at it, and
 * skips polling entirely while the tab is hidden — a background tab that keeps
 * hitting the DB every 30s for nobody is the cost with none of the benefit.
 *
 * Scoped to buyback.* by product decision. The API's PATCH carries the SAME
 * filter as its GET, so "mark all read" cannot reach the 537 non-buyback
 * notifications this feed hides — marking an undisplayed escalation read would
 * destroy it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useRouter } from "next/navigation";

/** Slow on purpose — see the docblock. A bell is not a trading screen. */
const POLL_MS = 60_000;

interface Note {
  id: string;
  type: string;
  title: string;
  message: string;
  data: unknown;
  read: boolean | null;
  created_at: string;
}

/** Where a notification points. Null when it names nothing to open. */
function hrefFor(note: Note, isAdmin: boolean): string | null {
  const data = (note.data ?? {}) as { request_id?: string };
  if (!data.request_id) return null;
  // The same id, two different screens — a dealer has no admin deal page.
  return isAdmin
    ? `/admin/buyback/${data.request_id}`
    : `/dealer-portal/buyback/${data.request_id}`;
}

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function BuybackBell({ isAdmin = false }: { isAdmin?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/buyback/notifications");
      const json = await res.json();
      if (json?.success === false) return; // a bell must never shout at anyone
      setNotes(json?.data?.notifications ?? []);
      setUnread(json?.data?.unread_count ?? 0);
    } catch {
      // Silent by design. A failed poll is not news; it is a bell that stays
      // as it was until the next tick.
    }
  }, []);

  useEffect(() => {
    void load();

    // No polling while nobody is looking.
    const tick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const id = setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);

    return () => {
      clearInterval(id);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  // Close on an outside click, like the profile dropdown beside it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const markAllRead = async () => {
    setLoading(true);
    try {
      // No body → the API marks THIS caller's buyback feed, and only that.
      await fetch("/api/buyback/notifications", { method: "PATCH" });
      await load();
    } finally {
      setLoading(false);
    }
  };

  const openNote = async (note: Note) => {
    const href = hrefFor(note, isAdmin);
    // Mark just this one, by id — reading one notification must not silently
    // clear the rest of the backlog.
    void fetch("/api/buyback/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [note.id] }),
    }).then(() => load());

    setOpen(false);
    if (href) router.push(href);
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `${unread} unread buyback notifications` : "Buyback notifications"}
        className="relative p-2 text-gray-500 hover:bg-gray-100 rounded-full transition-colors"
      >
        <Bell className="w-5 h-5" />
        {/* Only when there is something. The old dot was hardcoded — always on,
            so it told you nothing, which is worse than no dot at all. */}
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-white bg-red-500 px-1 text-[9px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[360px] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
            <span className="text-[13px] font-bold text-slate-900">Buyback</span>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                disabled={loading}
                className="text-[11.5px] font-semibold text-blue-600 hover:underline disabled:opacity-50"
              >
                {loading ? "Marking…" : "Mark all read"}
              </button>
            )}
          </div>

          {notes.length === 0 ? (
            <p className="px-4 py-8 text-center text-[12.5px] text-slate-400">
              Nothing yet.
            </p>
          ) : (
            <ul className="max-h-[380px] overflow-y-auto">
              {notes.map((n) => {
                const isUnread = n.read !== true;
                const href = hrefFor(n, isAdmin);
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => void openNote(n)}
                      className={`flex w-full gap-2.5 border-b border-gray-50 px-4 py-3 text-left hover:bg-slate-50 ${
                        isUnread ? "bg-blue-50/40" : ""
                      }`}
                    >
                      <span
                        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                          isUnread ? "bg-blue-500" : "bg-transparent"
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12.5px] font-semibold text-slate-900">
                          {n.title}
                        </span>
                        <span className="mt-0.5 block truncate text-[11.5px] text-slate-500">
                          {n.message}
                        </span>
                        <span className="mt-1 block text-[10.5px] text-slate-400">
                          {timeAgo(n.created_at)}
                          {/* Say when it goes nowhere, rather than looking
                              clickable and doing nothing. */}
                          {!href ? " · no linked request" : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
