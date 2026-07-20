"use client";

/**
 * The full notification centre body — filters + list + pagination + row/bulk
 * actions. Role-agnostic: every row already carries its own role-correct `href`
 * from the API, so this one component serves the dealer, admin, and vendor
 * pages; each page only wraps it in its own chrome.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  useBuybackNotificationActions,
  useBuybackNotifications,
  type BuybackNote,
} from "@/hooks/useBuybackNotifications";
import { useBuybackNotificationSummary } from "@/hooks/useBuybackNotificationSummary";
import type { NotificationCategory } from "@/lib/buyback/notification-meta";

import NotificationFilters, {
  type NotificationStatusFilter,
  type NotificationView,
} from "./NotificationFilters";
import NotificationList from "./NotificationList";

export default function NotificationCenter() {
  const router = useRouter();
  const [status, setStatus] = useState<NotificationStatusFilter>("all");
  const [category, setCategory] = useState<NotificationCategory | null>(null);
  const [view, setView] = useState<NotificationView>("active");
  const [search, setSearch] = useState("");

  const {
    notifications,
    unreadCount,
    isLoading,
    isError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useBuybackNotifications({ status, category, view, limit: 30 });
  const { markRead, markAllRead, archive, unarchive, remove } = useBuybackNotificationActions();
  const summary = useBuybackNotificationSummary();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return notifications;
    return notifications.filter(
      (n) => n.title.toLowerCase().includes(q) || n.message.toLowerCase().includes(q),
    );
  }, [notifications, search]);

  const openNote = (n: BuybackNote) => {
    if (n.read !== true) markRead.mutate([n.id]);
    if (n.href) router.push(n.href);
  };

  return (
    <div className="space-y-4">
      <NotificationFilters
        status={status}
        onStatus={setStatus}
        category={category}
        onCategory={setCategory}
        search={search}
        onSearch={setSearch}
        view={view}
        onView={setView}
        counts={summary.unread.byCategory}
      />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
          <span className="text-[12.5px] font-semibold text-slate-600">
            {view === "archived" ? "Archived" : "Inbox"}
            {unreadCount > 0 ? ` · ${unreadCount} unread` : ""}
          </span>
          {unreadCount > 0 && view === "active" && (
            <button
              onClick={() => markAllRead.mutate(category)}
              disabled={markAllRead.isPending}
              className="text-[11.5px] font-semibold text-blue-600 hover:underline disabled:opacity-50"
            >
              {markAllRead.isPending ? "Marking…" : category ? `Mark ${category} read` : "Mark all read"}
            </button>
          )}
        </div>

        <NotificationList
          items={filtered}
          loading={isLoading}
          error={isError}
          emptyLabel={
            search
              ? "No notifications match your search."
              : view === "archived"
                ? "No archived notifications."
                : "You're all caught up."
          }
          onOpen={openNote}
          onMarkRead={(n) => markRead.mutate([n.id])}
          onArchive={(n) => {
            archive.mutate([n.id]);
            toast.success("Archived");
          }}
          onUnarchive={(n) => unarchive.mutate([n.id])}
          onDelete={(n) => {
            remove.mutate([n.id]);
            toast.success("Deleted");
          }}
        />

        {hasNextPage && !search && (
          <button
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="block w-full border-t border-slate-100 px-4 py-3 text-center text-[12px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {isFetchingNextPage ? "Loading…" : "Load older"}
          </button>
        )}
      </div>
    </div>
  );
}
