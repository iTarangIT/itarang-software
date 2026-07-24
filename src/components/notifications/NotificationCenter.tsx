"use client";

/**
 * The full notification centre body — filters + list + pagination + row/bulk
 * actions + inline one-click actions.
 *
 * Role-agnostic: every row already carries its own role-correct `href`,
 * provenance and actions from the API, so this one component serves the admin,
 * dealer, NBFC and vendor pages; each page only wraps it in its own chrome.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  useNotificationActions,
  useNotificationSummary,
  useNotifications,
  type Note,
  type NoteAction,
} from "@/hooks/useNotifications";
import type { NotificationCategory } from "@/lib/notifications/catalog";

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
    refetch,
  } = useNotifications({ status, category, view, limit: 30 });
  const { markRead, markAllRead, archive, unarchive, remove } = useNotificationActions();
  const summary = useNotificationSummary();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return notifications;
    return notifications.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.message.toLowerCase().includes(q) ||
        (n.from?.label ?? "").toLowerCase().includes(q) ||
        (n.stage ?? "").toLowerCase().includes(q),
    );
  }, [notifications, search]);

  const openNote = (n: Note) => {
    if (n.read !== true) markRead.mutate([n.id]);
    if (n.href) router.push(n.href);
  };

  /**
   * Fire a one-click action against its ordinary session-authenticated
   * endpoint. A failure here is a real 4xx/5xx worth surfacing — the user needs
   * to know their "Forward to dealer" did not happen.
   */
  const runAction = async (n: Note, a: NoteAction): Promise<boolean> => {
    if (a.opensHref) {
      openNote(n);
      return true;
    }
    try {
      const res = await fetch(a.endpoint, {
        method: a.method ?? "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(a.body ?? {}),
      });
      const json = await res.json().catch(() => ({}));
      const ok = res.ok && json?.ok !== false && json?.success !== false;
      if (ok) {
        toast.success(a.successLabel ?? "Done");
        markRead.mutate([n.id]);
        await refetch();
      } else {
        toast.error(json?.error?.message ?? json?.error ?? "Action failed");
      }
      return ok;
    } catch {
      toast.error("Action failed");
      return false;
    }
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
        counts={summary.byCategory}
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
          onAction={runAction}
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
