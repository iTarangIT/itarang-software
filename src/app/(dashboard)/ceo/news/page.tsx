"use client";

// /ceo/news — the full Green Energy News feed (E-306): India / World and
// category filters, a day window, the brief for the day, stories grouped by
// IST day, "Load more" by cursor and a "Not relevant" hide per row.

import React from "react";
import Link from "next/link";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Newspaper } from "lucide-react";

import { NEWS_CATEGORIES, NEWS_CATEGORY_KEYS, type NewsCategory, type NewsRegion } from "@/lib/news/categories";
import type { NewsItemRow } from "@/lib/news/queries";
import { istDateString, istDayLabel } from "@/lib/news/time";
import { timeAgo } from "@/components/notifications/NotificationList";
import {
  BriefBullets,
  HeadlineRow,
  NEWS_QUERY_KEY,
  RefreshNewsButton,
  fetchNews,
  type NewsFeedResponse,
} from "@/components/dashboard/ceo/GreenNewsCard";

const DAY_OPTIONS = [
  { days: 1, label: "Last 24 h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 h-8 text-xs font-semibold rounded-full border transition-colors ${
        active
          ? "bg-brand-600 border-brand-600 text-white"
          : "bg-white border-gray-200 text-gray-600 hover:border-brand-200 hover:text-brand-700"
      }`}
    >
      {children}
    </button>
  );
}

export default function CeoNewsPage() {
  const qc = useQueryClient();
  const [region, setRegion] = React.useState<NewsRegion | null>(null);
  const [category, setCategory] = React.useState<NewsCategory | null>(null);
  const [days, setDays] = React.useState<number>(7);
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());

  const baseQs = React.useMemo(() => {
    const p = new URLSearchParams();
    if (region) p.set("region", region);
    if (category) p.set("category", category);
    p.set("days", String(days));
    p.set("limit", "30");
    p.set("brief_date", istDateString());
    return p;
  }, [region, category, days]);

  const q = useInfiniteQuery<NewsFeedResponse>({
    queryKey: [...NEWS_QUERY_KEY, "list", baseQs.toString()],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(baseQs);
      if (pageParam) p.set("cursor", String(pageParam));
      return fetchNews(p.toString());
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    staleTime: 5 * 60 * 1000,
  });

  const hide = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/dashboard/ceo/news/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: true }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Could not hide");
      return id;
    },
    onSuccess: (id) => {
      setHidden((s) => new Set(s).add(id));
      qc.invalidateQueries({ queryKey: [...NEWS_QUERY_KEY, "top"] });
    },
  });

  const first = q.data?.pages[0];
  const items = (q.data?.pages.flatMap((p) => p.items) ?? []).filter((i) => !hidden.has(i.id));

  // Group by IST day for the dividers.
  const groups: { day: string; items: NewsItemRow[] }[] = [];
  for (const it of items) {
    const day = istDateString(new Date(it.published_at));
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.items.push(it);
    else groups.push({ day, items: [it] });
  }
  const today = istDateString();
  const updated = first?.lastRun?.finished_at ?? first?.lastRun?.started_at ?? null;

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <Link
            href="/ceo"
            className="inline-flex items-center gap-1 text-xs font-semibold text-gray-500 hover:text-brand-700 mb-2"
          >
            <ArrowLeft className="w-3 h-3" /> CEO overview
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight flex items-center gap-2">
            <Newspaper className="w-6 h-6 text-brand-600" /> Green Energy News
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            What is happening in green energy — world and India — refreshed every 2 hours from
            industry feeds and Google News, tagged and summarised automatically.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {updated && <span className="text-[11px] text-gray-400">Updated {timeAgo(updated)}</span>}
          <RefreshNewsButton />
        </div>
      </div>

      {first?.brief && (
        <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-3">
            Morning brief · {istDayLabel(first.brief.brief_date)}
            {first.brief.brief_date !== today ? " (latest available)" : ""}
          </p>
          <BriefBullets brief={first.brief} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Chip active={region === null} onClick={() => setRegion(null)}>
          All
        </Chip>
        <Chip active={region === "india"} onClick={() => setRegion("india")}>
          India
        </Chip>
        <Chip active={region === "world"} onClick={() => setRegion("world")}>
          World
        </Chip>
        <span className="mx-1 h-5 w-px bg-gray-200" />
        <Chip active={category === null} onClick={() => setCategory(null)}>
          All topics
        </Chip>
        {NEWS_CATEGORY_KEYS.filter((k) => k !== "other").map((k) => (
          <Chip key={k} active={category === k} onClick={() => setCategory(category === k ? null : k)}>
            {NEWS_CATEGORIES[k]}
          </Chip>
        ))}
        <span className="ml-auto inline-flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5">
          {DAY_OPTIONS.map((o) => (
            <button
              key={o.days}
              type="button"
              onClick={() => setDays(o.days)}
              className={`px-3 h-7 text-xs font-semibold rounded-md transition-colors ${
                days === o.days ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {o.label}
            </button>
          ))}
        </span>
      </div>

      {q.error ? (
        <div className="p-4 rounded-2xl bg-rose-50 border border-rose-100 text-sm text-rose-700">
          {(q.error as Error).message}
        </div>
      ) : q.isLoading ? (
        <div className="space-y-2 animate-pulse">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-16 bg-gray-50 rounded-xl border border-gray-100" />
          ))}
        </div>
      ) : first && !first.enabled ? (
        <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm text-sm text-gray-500">
          The news feed is switched off (app_settings › green_news). Nothing is being fetched.
        </div>
      ) : items.length === 0 ? (
        <div className="p-10 rounded-2xl bg-white border border-gray-100 shadow-sm text-center">
          <Newspaper className="w-8 h-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-500">No stories match these filters</p>
          <p className="text-xs text-gray-400 mt-1">
            Try a wider window, or press Refresh if the feed has not run yet.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.day}>
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-2">
                {g.day === today ? "Today" : istDayLabel(g.day)}
                <span className="ml-2 font-medium text-gray-400 normal-case tracking-normal">
                  {g.items.length} {g.items.length === 1 ? "story" : "stories"}
                </span>
              </h2>
              <div className="space-y-2">
                {g.items.map((it) => (
                  <HeadlineRow key={it.id} item={it} onHide={(id) => hide.mutate(id)} />
                ))}
              </div>
            </section>
          ))}
          {q.hasNextPage && (
            <button
              type="button"
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
              className="w-full py-2.5 text-xs font-semibold text-brand-700 hover:bg-brand-50 rounded-xl border border-brand-100 transition-colors disabled:opacity-60"
            >
              {q.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
