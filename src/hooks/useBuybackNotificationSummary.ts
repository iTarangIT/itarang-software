"use client";

/**
 * Buyback notification counts — one query behind BOTH the sidebar badges
 * ("Notifications (5)", "Negotiations (2)") and the dashboard action-center
 * strip. Shares the `buyback-notifications` key prefix with the feed so a
 * mark-read anywhere decrements the badges, and every consumer dedupes to one
 * request. Polls 20s, pauses while hidden, catches up on refocus.
 */

import { useQuery } from "@tanstack/react-query";

import { CATEGORIES, type NotificationCategory } from "@/lib/buyback/notification-meta";

export interface BuybackActionChip {
  key: string;
  label: string;
  count: number;
  href: string;
}

export interface BuybackNotificationSummary {
  unread: { total: number; byCategory: Record<NotificationCategory, number> };
  actions: BuybackActionChip[];
}

const emptyByCategory = (): Record<NotificationCategory, number> =>
  Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<NotificationCategory, number>;

const EMPTY: BuybackNotificationSummary = { unread: { total: 0, byCategory: emptyByCategory() }, actions: [] };

export function useBuybackNotificationSummary(enabled = true): BuybackNotificationSummary {
  const { data } = useQuery({
    queryKey: ["buyback-notifications", "summary"],
    queryFn: async (): Promise<BuybackNotificationSummary> => {
      const res = await fetch("/api/buyback/notifications/summary");
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error ?? "Failed to load notification summary");
      }
      const d = json?.data ?? {};
      return {
        unread: {
          total: Number(d?.unread?.total ?? 0),
          byCategory: { ...emptyByCategory(), ...(d?.unread?.byCategory ?? {}) },
        },
        actions: Array.isArray(d?.actions) ? d.actions : [],
      };
    },
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
    enabled,
  });

  return data ?? EMPTY;
}
