"use client";

/**
 * The single in-app notification bell, shared by all four portals — admin,
 * dealer, NBFC and vendor.
 *
 * It reads `/api/notifications`, which returns every row addressed to the
 * signed-in user regardless of which module produced it: lead creation, KYC and
 * consent, the NBFC ⇄ admin ⇄ dealer request loop, FI / Video KYC / E-NACH /
 * agreement, product selection, sanction and disbursal, dealer onboarding
 * (portal and WhatsApp), inventory, buyback, escalations.
 *
 * Three things the server does for us, so this component stays simple:
 *  - ROUTING. Every row arrives with an `href` already resolved for THIS
 *    viewer's portal (`emit()` writes one per recipient; the API falls back to
 *    the catalog for pre-hub rows). We never re-derive a destination here.
 *  - PROVENANCE. `from` / `to` / `stage` say who raised the item and who holds
 *    it — "Bajaj Finance → iTarang Admin · Field Investigation" — which is the
 *    only way a hand-off chain reads correctly when the same request bounces
 *    NBFC → admin → dealer → admin → NBFC.
 *  - ACTIONS. `actions` are one-click decisions the viewer can take without
 *    leaving the dropdown; they POST ordinary session-authenticated endpoints,
 *    so this adds no new server surface. Anything needing input carries
 *    `opensHref` instead and simply navigates.
 *
 * Polling contract inherited from the old buyback bell: slow poll, refetch on
 * focus, never poll while the tab is hidden.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { NotificationRole } from "@/lib/notifications/catalog";

const POLL_MS = 60_000;

interface Party {
  party?: string;
  label?: string;
  actor?: string | null;
}

interface NoteAction {
  label: string;
  endpoint: string;
  method?: "POST" | "PATCH" | "PUT";
  body?: Record<string, unknown>;
  confirm?: string;
  variant?: "primary" | "danger" | "neutral";
  opensHref?: boolean;
  successLabel?: string;
}

interface Note {
  id: string;
  type: string;
  title: string;
  message: string;
  lead_id: string | null;
  read: boolean | null;
  created_at: string;
  category?: string;
  priority?: "Info" | "Warning" | "Critical";
  href?: string | null;
  from?: Party | null;
  to?: Party | null;
  stage?: string | null;
  actions?: NoteAction[] | null;
}

/** Where the "View all" footer points, per portal. */
const ALL_HREF: Record<NotificationRole, string> = {
  admin: "/admin/notifications",
  dealer: "/dealer-portal/notifications",
  nbfc: "/nbfc/notifications",
  vendor: "/vendor-portal/notifications",
};

const DOT_CLASS: Record<string, string> = {
  Critical: "bg-rose-500",
  Warning: "bg-amber-500",
  Info: "bg-blue-500",
};

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** "Bajaj Finance → iTarang Admin · Field Investigation", when we know it. */
function provenance(n: Note): string | null {
  const from = n.from?.label;
  const to = n.to?.label;
  if (!from && !to) return n.stage ?? null;
  const base = `${from ?? "—"} → ${to ?? "—"}`;
  return n.stage ? `${base} · ${n.stage}` : base;
}

export default function NotificationBell({
  portalRole = "admin",
  headerSlot,
}: {
  /** Which portal the viewer is in. Only affects the "View all" destination —
   *  every row's own deep link is resolved server-side for this viewer. */
  portalRole?: NotificationRole;
  /** Rendered above the feed. The NBFC portal passes its work-queue counts here
   *  so that at-a-glance pipeline view survives alongside the real feed. */
  headerSlot?: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<Record<string, string>>({});
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      const json = await res.json();
      if (!json?.success) return;
      setNotes(json.data?.notifications ?? []);
      setUnread(json.data?.unread_count ?? 0);
    } catch {
      // silent by design — a failed poll must never surface as an error toast
    }
  }, []);

  useEffect(() => {
    void load();
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

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const markRead = (ids: string[]) =>
    fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });

  const markAllRead = async () => {
    setLoading(true);
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await load();
    } finally {
      setLoading(false);
    }
  };

  const openNote = (note: Note) => {
    if (note.read !== true) void markRead([note.id]).then(() => load());
    setOpen(false);
    if (note.href) router.push(note.href);
  };

  /**
   * Fire a one-click action. The endpoints are the app's ordinary routes, so a
   * failure here is a real 4xx/5xx worth showing inline rather than swallowing:
   * the admin needs to know their "Forward to dealer" did not happen.
   */
  const runAction = async (note: Note, action: NoteAction, index: number) => {
    if (action.opensHref) {
      openNote(note);
      return;
    }
    if (action.confirm && !window.confirm(action.confirm)) return;

    const key = `${note.id}:${index}`;
    setBusyAction(key);
    try {
      const res = await fetch(action.endpoint, {
        method: action.method ?? "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.body ?? {}),
      });
      const json = await res.json().catch(() => ({}));
      const ok = res.ok && json?.ok !== false && json?.success !== false;
      setActionResult((r) => ({
        ...r,
        [key]: ok
          ? (action.successLabel ?? "Done")
          : (json?.error?.message ?? json?.error ?? "Failed"),
      }));
      if (ok) {
        await markRead([note.id]);
        await load();
      }
    } catch {
      setActionResult((r) => ({ ...r, [key]: "Failed" }));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `${unread} unread notifications` : "Notifications"}
        className="relative p-2 text-gray-500 hover:bg-gray-100 rounded-full transition-colors"
      >
        <Bell className="w-5 h-5" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-white bg-red-500 px-1 text-[9px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
            <span className="text-[13px] font-bold text-slate-900">Notifications</span>
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

          <div className="max-h-[70vh] overflow-y-auto">
            {headerSlot}

            {notes.length === 0 ? (
              <p className="px-4 py-8 text-center text-[12.5px] text-slate-400">
                You&apos;re all caught up.
              </p>
            ) : (
              <ul>
                {notes.map((n) => {
                  const isUnread = n.read !== true;
                  const line = provenance(n);
                  const actions = (n.actions ?? []).slice(0, 2);
                  return (
                    <li key={n.id} className={`border-b border-gray-50 ${isUnread ? "bg-blue-50/40" : ""}`}>
                      <button
                        onClick={() => openNote(n)}
                        className="flex w-full gap-2.5 px-4 pt-3 pb-2 text-left hover:bg-slate-50"
                      >
                        <span
                          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                            isUnread ? (DOT_CLASS[n.priority ?? "Info"] ?? "bg-blue-500") : "bg-transparent"
                          }`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12.5px] font-semibold text-slate-900">
                            {n.title}
                          </span>
                          <span className="mt-0.5 block text-[11.5px] leading-snug text-slate-500 line-clamp-2">
                            {n.message}
                          </span>
                          {line && (
                            <span className="mt-1 block truncate text-[10.5px] font-medium text-slate-400">
                              {line}
                            </span>
                          )}
                          <span className="mt-0.5 block text-[10.5px] text-slate-400">
                            {timeAgo(n.created_at)}
                            {!n.href ? " · nothing to open" : ""}
                          </span>
                        </span>
                      </button>

                      {actions.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2.5 pl-[26px]">
                          {actions.map((a, i) => {
                            const key = `${n.id}:${i}`;
                            const result = actionResult[key];
                            if (result) {
                              return (
                                <span key={key} className="text-[11px] font-semibold text-slate-500">
                                  {result}
                                </span>
                              );
                            }
                            return (
                              <button
                                key={key}
                                onClick={() => runAction(n, a, i)}
                                disabled={busyAction === key}
                                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
                                  a.variant === "danger"
                                    ? "border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                                    : a.variant === "neutral"
                                      ? "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                                      : "bg-slate-800 text-white hover:bg-slate-900"
                                }`}
                              >
                                {busyAction === key && <Loader2 className="h-3 w-3 animate-spin" />}
                                {a.label}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <Link
            href={ALL_HREF[portalRole] ?? ALL_HREF.admin}
            onClick={() => setOpen(false)}
            className="block border-t border-gray-100 px-4 py-2.5 text-center text-[11.5px] font-semibold text-blue-600 hover:bg-slate-50"
          >
            View all notifications →
          </Link>
        </div>
      )}
    </div>
  );
}
