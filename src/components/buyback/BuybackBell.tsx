"use client";

/**
 * The buyback notification bell (items 12/13).
 *
 * POLLING, NOT REALTIME, and not by preference: the buyback tables are on AWS
 * RDS, Supabase here is auth-only, so Supabase Realtime cannot see them. The
 * shared React Query hook polls every 20s, pauses while the tab is hidden, and
 * catches up on refocus — see useBuybackNotifications. Every buyback role is fed
 * through the one feed now that dispatch.ts's writeBell honours recipient_party;
 * each row already carries its own role-correct `href`, so the bell never
 * computes a link.
 *
 * Scoped to buyback.* by product decision. The API's mutations carry the SAME
 * filter as its reads, so "mark all read" cannot reach the non-buyback
 * notifications this feed hides — marking an undisplayed escalation read would
 * destroy it.
 */

import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import NotificationList from "@/components/buyback/notifications/NotificationList";
import {
  useBuybackNotificationActions,
  useBuybackNotifications,
  type BuybackNote,
} from "@/hooks/useBuybackNotifications";

export type PortalRole = "dealer" | "admin" | "vendor";

const SEE_ALL: Record<PortalRole, string> = {
  admin: "/admin/buyback/notifications",
  dealer: "/dealer-portal/buyback/notifications",
  vendor: "/vendor-portal/notifications",
};

/** How many rows the dropdown shows before "See all". */
const BELL_ROWS = 12;

export default function BuybackBell({ role = "dealer" }: { role?: PortalRole }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);

  const { notifications, unreadCount, isLoading, isError } = useBuybackNotifications();
  const { markRead, markAllRead } = useBuybackNotificationActions();

  // Toast-on-new. Seed the seen-set from the first loaded page so the existing
  // backlog stays silent; after that, unseen unread rows fire a toast (a burst
  // collapses into one line so a batch of transitions can't spam the corner).
  useEffect(() => {
    if (isLoading) return;
    if (seen.current === null) {
      seen.current = new Set(notifications.map((n) => n.id));
      return;
    }
    const fresh = notifications.filter((n) => !seen.current!.has(n.id));
    if (fresh.length === 0) return;
    fresh.forEach((n) => seen.current!.add(n.id));

    const freshUnread = fresh.filter((n) => n.read !== true);
    if (freshUnread.length > 3) {
      toast(`${freshUnread.length} new notifications`, {
        action: { label: "View", onClick: () => router.push(SEE_ALL[role]) },
      });
    } else {
      for (const n of freshUnread) {
        toast(n.title, {
          description: n.message,
          action: n.href ? { label: "View", onClick: () => router.push(n.href!) } : undefined,
        });
      }
    }
  }, [notifications, isLoading, role, router]);

  // Close on an outside click, like the profile dropdown beside it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const openNote = (n: BuybackNote) => {
    if (n.read !== true) markRead.mutate([n.id]);
    setOpen(false);
    if (n.href) router.push(n.href);
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={unreadCount > 0 ? `${unreadCount} unread buyback notifications` : "Buyback notifications"}
        className="relative p-2 text-gray-500 hover:bg-gray-100 rounded-full transition-colors"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-white bg-red-500 px-1 text-[9px] font-bold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[380px] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
            <span className="text-[13px] font-bold text-slate-900">
              Notifications{unreadCount > 0 ? ` (${unreadCount})` : ""}
            </span>
            {unreadCount > 0 && (
              <button
                onClick={() => markAllRead.mutate(null)}
                disabled={markAllRead.isPending}
                className="text-[11.5px] font-semibold text-blue-600 hover:underline disabled:opacity-50"
              >
                {markAllRead.isPending ? "Marking…" : "Mark all read"}
              </button>
            )}
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            <NotificationList
              items={notifications.slice(0, BELL_ROWS)}
              loading={isLoading}
              error={isError}
              dense
              emptyLabel="Nothing yet."
              onOpen={openNote}
            />
          </div>

          <Link
            href={SEE_ALL[role]}
            onClick={() => setOpen(false)}
            className="block border-t border-gray-100 px-4 py-2.5 text-center text-[12px] font-semibold text-blue-600 hover:bg-slate-50"
          >
            See all notifications
          </Link>
        </div>
      )}
    </div>
  );
}
