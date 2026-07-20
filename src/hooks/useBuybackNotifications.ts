"use client";

/**
 * The buyback notification feed + its mutations, as React Query hooks.
 *
 * POLLING, NOT REALTIME — and deliberately so. The buyback tables are on AWS
 * RDS; Supabase here is auth-only, so Supabase Realtime cannot see them and
 * there is no websocket path. React Query polls every 20s AND pauses while the
 * tab is hidden (refetchIntervalInBackground defaults false), then catches up on
 * refocus — the near-real-time the product asked for without a self-inflicted
 * load on an unpooled instance.
 *
 * The bell, the full pages, and the sidebar/dashboard summary all share the
 * `buyback-notifications` query-key prefix, so one mutation invalidates every
 * surface at once and identical params dedupe to a single request.
 */

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import type { NotificationCategory, NotificationPriority } from "@/lib/buyback/notification-meta";

export interface BuybackNote {
  id: string;
  type: string;
  title: string;
  message: string;
  data: unknown;
  read: boolean | null;
  archived_at: string | null;
  created_at: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  href: string | null;
}

interface FeedPage {
  notifications: BuybackNote[];
  unread_count: number;
  next_cursor: string | null;
}

export interface BuybackFeedParams {
  status?: "unread" | "read" | "all";
  category?: NotificationCategory | null;
  view?: "active" | "archived";
  /** Server page size (the bell uses the default 30). */
  limit?: number;
  enabled?: boolean;
}

async function fetchFeedPage(params: BuybackFeedParams, cursor?: string): Promise<FeedPage> {
  const qs = new URLSearchParams();
  if (params.status && params.status !== "all") qs.set("status", params.status);
  if (params.category) qs.set("category", params.category);
  if (params.view === "archived") qs.set("view", "archived");
  if (params.limit) qs.set("limit", String(params.limit));
  if (cursor) qs.set("cursor", cursor);

  const res = await fetch(`/api/buyback/notifications?${qs.toString()}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    throw new Error(json?.error ?? "Failed to load notifications");
  }
  const d = json?.data ?? {};
  return {
    notifications: Array.isArray(d.notifications) ? d.notifications : [],
    unread_count: Number(d.unread_count ?? 0),
    next_cursor: d.next_cursor ?? null,
  };
}

export function useBuybackNotifications(params: BuybackFeedParams = {}) {
  const { status = "all", category = null, view = "active", limit, enabled = true } = params;

  const q = useInfiniteQuery({
    queryKey: ["buyback-notifications", "feed", { status, category, view, limit: limit ?? null }],
    queryFn: ({ pageParam }) =>
      fetchFeedPage({ status, category, view, limit }, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
    enabled,
  });

  return {
    notifications: q.data?.pages.flatMap((p) => p.notifications) ?? [],
    unreadCount: q.data?.pages[0]?.unread_count ?? 0,
    isLoading: q.isLoading,
    isError: q.isError,
    hasNextPage: q.hasNextPage,
    fetchNextPage: q.fetchNextPage,
    isFetchingNextPage: q.isFetchingNextPage,
    refetch: q.refetch,
  };
}

/**
 * Mark-read / mark-all / archive / unarchive / delete, each invalidating every
 * buyback-notification surface on success (the shared key prefix).
 */
export function useBuybackNotificationActions() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["buyback-notifications"] });

  const patch = (body: Record<string, unknown>) =>
    fetch("/api/buyback/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => {
      if (!r.ok) throw new Error("Request failed");
    });

  const del = (ids: string[]) =>
    fetch("/api/buyback/notifications", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).then((r) => {
      if (!r.ok) throw new Error("Request failed");
    });

  return {
    markRead: useMutation({ mutationFn: (ids: string[]) => patch({ ids, action: "read" }), onSuccess: invalidate }),
    markAllRead: useMutation({
      mutationFn: (category?: string | null) => patch(category ? { action: "read", category } : { action: "read" }),
      onSuccess: invalidate,
    }),
    archive: useMutation({ mutationFn: (ids: string[]) => patch({ ids, action: "archive" }), onSuccess: invalidate }),
    unarchive: useMutation({ mutationFn: (ids: string[]) => patch({ ids, action: "unarchive" }), onSuccess: invalidate }),
    remove: useMutation({ mutationFn: (ids: string[]) => del(ids), onSuccess: invalidate }),
  };
}
