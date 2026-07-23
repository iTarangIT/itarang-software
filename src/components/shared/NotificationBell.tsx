"use client";

/**
 * The single unified in-app notification bell. Surfaces the `notifications` rows
 * keyed to the SIGNED-IN user (/api/notifications) — EVERY type lands here:
 * KYC verification arrivals, NBFC Acquire events, buyback, dealer validation,
 * inventory uploads, escalations, etc. Modeled on the old BuybackBell's polling
 * contract (slow poll, focus refetch, no polling while hidden) but no longer
 * scoped to any one feature — it replaced the second (buyback-only) bell.
 *
 * Routing (`hrefFor`) is type/data-aware:
 *  - buyback (type `buyback.*` or `data.request_id`) → admin vs dealer deal page
 *    (chosen by `isAdmin`), or the per-category vendor-portal surface when
 *    `portalRole` is "vendor",
 *  - lead-linked (`lead_id`/`data.leadId`) → admin KYC review or NBFC Acquire
 *    detail (chosen by `variant`),
 *  - anything carrying an explicit `data.href` → that URL verbatim (the escape
 *    hatch for newer notification types, e.g. dealer validation / inventory).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useRouter } from "next/navigation";

// Pure, framework-free taxonomy shared with the buyback API — the one place
// that knows which page a buyback event opens for which portal role.
import { categorize, linkFor, type NotificationRole } from "@/lib/buyback/notification-meta";

const POLL_MS = 60_000;

interface Note {
  id: string;
  type: string;
  title: string;
  message: string;
  data: unknown;
  lead_id: string | null;
  read: boolean | null;
  created_at: string;
}

function hrefFor(
  note: Note,
  variant: "admin" | "nbfc",
  isAdmin: boolean,
  portalRole: NotificationRole,
): string | null {
  const data = (note.data ?? {}) as {
    leadId?: string;
    request_id?: string;
    href?: string;
    url?: string;
  };
  const type = note.type || "";

  // Explicit destination wins — the escape hatch for notification types that
  // don't fit the buyback/lead shapes (dealer validation, inventory uploads…).
  if (data.href) return data.href;
  if (data.url) return data.url;

  // Buyback → the request-scoped deal page. The same id maps to three screens:
  // a dealer has no admin deal page, and a vendor has neither — its surfaces are
  // per-category (bids, inbox, orders, payments), which only linkFor knows. Ask
  // it rather than keep a second, drifting copy of that mapping here.
  if (type.startsWith("buyback.") || data.request_id) {
    if (portalRole === "vendor") return linkFor("vendor", categorize(type), data);
    if (!data.request_id) return null;
    return isAdmin
      ? `/admin/buyback/${data.request_id}`
      : `/dealer-portal/buyback/${data.request_id}`;
  }

  // Lead-linked (KYC verification, NBFC Acquire, dealer-uploaded docs).
  const leadId = note.lead_id ?? data.leadId;
  if (!leadId) return null;
  return variant === "admin"
    ? `/admin/kyc-review/${leadId}`
    : `/nbfc/acquire/${leadId}`;
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

export default function NotificationBell({
  variant = "admin",
  isAdmin = false,
  portalRole = "dealer",
}: {
  variant?: "admin" | "nbfc";
  // Drives role-aware deep links (admin vs dealer buyback pages). The feed
  // itself is always the signed-in user's own notifications regardless.
  isAdmin?: boolean;
  // Which portal the viewer is in, for buyback deep links only. Defaults to
  // "dealer" so every existing caller keeps its current behaviour.
  portalRole?: NotificationRole;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      const json = await res.json();
      if (json?.ok === false) return;
      setNotes(json?.notifications ?? []);
      setUnread(json?.unread ?? 0);
    } catch {
      // silent by design
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

  const markAllRead = async () => {
    setLoading(true);
    try {
      await fetch("/api/notifications", { method: "PATCH" });
      await load();
    } finally {
      setLoading(false);
    }
  };

  const openNote = (note: Note) => {
    const href = hrefFor(note, variant, isAdmin, portalRole);
    void fetch("/api/notifications", {
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
        <div className="absolute right-0 z-50 mt-2 w-[360px] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
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

          {notes.length === 0 ? (
            <p className="px-4 py-8 text-center text-[12.5px] text-slate-400">
              Nothing yet.
            </p>
          ) : (
            <ul className="max-h-[380px] overflow-y-auto">
              {notes.map((n) => {
                const isUnread = n.read !== true;
                const href = hrefFor(n, variant, isAdmin, portalRole);
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => openNote(n)}
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
                          {!href ? " · nothing to open" : ""}
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
