"use client";

/**
 * The CRM-wide notification feed + its mutations, as React Query hooks.
 *
 * Reads `/api/notifications`, which serves every portal — admin, dealer, NBFC
 * and vendor all get their own rows from the one route. Modelled on
 * `useBuybackNotifications` (same envelope, same keyset paging, same mutation
 * set); the difference is the endpoint and that rows also carry provenance
 * (`from`/`to`/`stage`) and inline `actions`.
 *
 * POLLING, NOT REALTIME — and deliberately so. The CRM tables are on AWS RDS;
 * Supabase here is auth-only, so Supabase Realtime cannot see them and there is
 * no websocket path. React Query polls every 20s AND pauses while the tab is
 * hidden (refetchIntervalInBackground defaults false), then catches up on
 * refocus.
 *
 * Every surface shares the `notifications` query-key prefix, so one mutation
 * invalidates them all at once and identical params dedupe to a single request.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  NotificationCategory,
  NotificationPriority,
  NotificationRole,
} from "@/lib/notifications/catalog";

/** The "from"/"to" halves of the provenance line. */
export interface NoteParty {
  party?: string;
  label?: string;
  actor?: string | null;
}

/** A one-click action rendered as a button on the row. */
export interface NoteAction {
  label: string;
  endpoint: string;
  method?: "POST" | "PATCH" | "PUT";
  body?: Record<string, unknown>;
  confirm?: string;
  variant?: "primary" | "danger" | "neutral";
  opensHref?: boolean;
  successLabel?: string;
}

export interface Note {
  id: string;
  type: string;
  title: string;
  message: string;
  data: unknown;
  lead_id: string | null;
  read: boolean | null;
  archived_at: string | null;
  created_at: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  href: string | null;
  from: NoteParty | null;
  to: NoteParty | null;
  stage: string | null;
  actions: NoteAction[] | null;
}

interface FeedPage {
  notifications: Note[];
  unread_count: number;
  next_cursor: string | null;
  role: NotificationRole;
}

export interface FeedParams {
  status?: "unread" | "read" | "all";
  category?: NotificationCategory | null;
  view?: "active" | "archived";
  /** Server page size (the bell uses the default 30). */
  limit?: number;
  enabled?: boolean;
}

async function fetchFeedPage(params: FeedParams, cursor?: string): Promise<FeedPage> {
  const qs = new URLSearchParams();
  if (params.status && params.status !== "all") qs.set("status", params.status);
  if (params.category) qs.set("category", params.category);
  if (params.view === "archived") qs.set("view", "archived");
  if (params.limit) qs.set("limit", String(params.limit));
  if (cursor) qs.set("cursor", cursor);

  const res = await fetch(`/api/notifications?${qs.toString()}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    throw new Error(json?.error?.message ?? "Failed to load notifications");
  }
  const d = json?.data ?? {};
  return {
    notifications: Array.isArray(d.notifications) ? d.notifications : [],
    unread_count: Number(d.unread_count ?? 0),
    next_cursor: d.next_cursor ?? null,
    role: (d.role ?? "admin") as NotificationRole,
  };
}

export function useNotifications(params: FeedParams = {}) {
  const { status = "all", category = null, view = "active", limit, enabled = true } = params;

  const q = useInfiniteQuery({
    queryKey: ["notifications", "feed", { status, category, view, limit: limit ?? null }],
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
    role: q.data?.pages[0]?.role ?? ("admin" as NotificationRole),
    isLoading: q.isLoading,
    isError: q.isError,
    hasNextPage: q.hasNextPage,
    fetchNextPage: q.fetchNextPage,
    isFetchingNextPage: q.isFetchingNextPage,
    refetch: q.refetch,
  };
}

/** Unread totals per category — badges the filter pills. */
export function useNotificationSummary() {
  const q = useQuery({
    queryKey: ["notifications", "summary"],
    queryFn: async () => {
      const res = await fetch("/api/notifications/summary");
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) throw new Error("Failed to load summary");
      return json.data as { unread: { total: number; byCategory: Record<string, number> } };
    },
    refetchInterval: 20_000,
    staleTime: 10_000,
  });

  return {
    total: q.data?.unread.total ?? 0,
    byCategory: (q.data?.unread.byCategory ?? {}) as Partial<Record<NotificationCategory, number>>,
    isLoading: q.isLoading,
  };
}

/**
 * Mark-read / mark-all / archive / unarchive / delete, each invalidating every
 * notification surface on success (the shared key prefix).
 */
export function useNotificationActions() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["notifications"] });

  const patch = (body: Record<string, unknown>) =>
    fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => {
      if (!r.ok) throw new Error("Request failed");
    });

  const del = (ids: string[]) =>
    fetch("/api/notifications", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).then((r) => {
      if (!r.ok) throw new Error("Request failed");
    });

  return {
    markRead: useMutation({
      mutationFn: (ids: string[]) => patch({ ids, action: "read" }),
      onSuccess: invalidate,
    }),
    markAllRead: useMutation({
      mutationFn: (category?: string | null) =>
        patch(category ? { action: "read", category } : { action: "read" }),
      onSuccess: invalidate,
    }),
    archive: useMutation({
      mutationFn: (ids: string[]) => patch({ ids, action: "archive" }),
      onSuccess: invalidate,
    }),
    unarchive: useMutation({
      mutationFn: (ids: string[]) => patch({ ids, action: "unarchive" }),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: (ids: string[]) => del(ids), onSuccess: invalidate }),
  };
}
