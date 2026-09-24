"use client";

// E-306 — "Green Energy Today" on the CEO overview: the morning brief on the
// left, the top headlines of the last 24 h on the right. Data is whatever the
// last refresh (src/lib/news/run.ts) left in the tables; the card never fetches
// a feed itself. The row/pill pieces are exported for /ceo/news.

import Link from "next/link";
import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ExternalLink, EyeOff, Newspaper, RefreshCw } from "lucide-react";

import { NEWS_CATEGORIES, NEWS_REGIONS } from "@/lib/news/categories";
import type { NewsItemRow, NewsRunRow } from "@/lib/news/queries";
import { istDayLabel } from "@/lib/news/time";
import { timeAgo } from "@/components/notifications/NotificationList";

export type BriefLink = { id: string; url: string; title: string };
export type BriefView = {
  brief_date: string;
  bullets: { text: string; links: BriefLink[] }[];
  item_count: number;
  generated_at: string;
};

export type NewsFeedResponse = {
  enabled: boolean;
  lastRun: NewsRunRow | null;
  brief: BriefView | null;
  items: NewsItemRow[];
  nextCursor?: string | null;
};

export const NEWS_QUERY_KEY = ["ceo-green-news"] as const;

export async function fetchNews(qs: string): Promise<NewsFeedResponse> {
  const res = await fetch(`/api/dashboard/ceo/news?${qs}`, { cache: "no-store" });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Could not load the news feed");
  return json.data as NewsFeedResponse;
}

const CATEGORY_TONE: Record<string, string> = {
  policy_subsidy: "bg-violet-50 text-violet-700 border-violet-100",
  funding_investment: "bg-amber-50 text-amber-700 border-amber-100",
  ev_battery: "bg-brand-50 text-brand-700 border-brand-100",
  solar_wind: "bg-yellow-50 text-yellow-700 border-yellow-100",
  grid_storage: "bg-sky-50 text-sky-700 border-sky-100",
  business_model: "bg-emerald-50 text-emerald-700 border-emerald-100",
  other: "bg-gray-50 text-gray-600 border-gray-100",
};

export function CategoryPill({ category }: { category: string | null }) {
  if (!category) return null;
  const label = (NEWS_CATEGORIES as Record<string, string>)[category] ?? category;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${CATEGORY_TONE[category] ?? CATEGORY_TONE.other}`}
    >
      {label}
    </span>
  );
}

export function RegionPill({ region }: { region: string | null }) {
  if (!region) return null;
  const label = (NEWS_REGIONS as Record<string, string>)[region] ?? region;
  const cls =
    region === "india"
      ? "bg-orange-50 text-orange-700 border-orange-100"
      : "bg-slate-50 text-slate-600 border-slate-200";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
      {label}
    </span>
  );
}

function SourceBadge({ name }: { name: string | null }) {
  const initials = (name ?? "?")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="h-9 w-9 shrink-0 rounded-lg bg-brand-100 text-brand-700 flex items-center justify-center text-[11px] font-bold">
      {initials}
    </div>
  );
}

/** One headline. `onHide` adds the "Not relevant" action (the full page only). */
export function HeadlineRow({
  item,
  showSummary = true,
  onHide,
}: {
  item: NewsItemRow;
  showSummary?: boolean;
  onHide?: (id: string) => void;
}) {
  const thumb = item.image_url && /^https:\/\//i.test(item.image_url) ? item.image_url : null;
  return (
    <div className="group flex items-start gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100 hover:bg-white hover:border-brand-100 transition-all">
      {thumb ? (
        // Plain <img>: images.unoptimized is on and the CSP allows any https image.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumb}
          alt=""
          loading="lazy"
          className="h-9 w-9 shrink-0 rounded-lg object-cover bg-gray-100"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <SourceBadge name={item.source_name} />
      )}
      <div className="min-w-0 flex-1">
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-semibold text-gray-900 hover:text-brand-700 leading-snug line-clamp-2"
        >
          {item.title}
          <ExternalLink className="inline-block w-3 h-3 ml-1 -mt-0.5 text-gray-300 group-hover:text-brand-400" />
        </a>
        {showSummary && item.summary && (
          <p className="text-xs text-gray-500 mt-1 leading-relaxed line-clamp-2">{item.summary}</p>
        )}
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          <RegionPill region={item.region} />
          <CategoryPill category={item.category} />
          <span className="text-[11px] text-gray-400 truncate">
            {item.source_name ?? "—"} · {timeAgo(item.published_at)}
          </span>
          {onHide && (
            <button
              type="button"
              onClick={() => onHide(item.id)}
              title="Not relevant — hide this story"
              className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-gray-400 hover:text-rose-600 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <EyeOff className="w-3 h-3" /> Not relevant
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function BriefBullets({ brief }: { brief: BriefView }) {
  return (
    <ol className="space-y-2.5">
      {brief.bullets.map((b, i) => {
        const first = b.links[0];
        return (
          <li key={i} className="flex gap-2.5 text-sm text-gray-700 leading-relaxed">
            <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-brand-50 text-brand-700 text-[11px] font-bold flex items-center justify-center">
              {i + 1}
            </span>
            <span>
              {b.text}
              {first && (
                <a
                  href={first.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1.5 text-[11px] font-semibold text-brand-700 hover:underline whitespace-nowrap"
                  title={first.title}
                >
                  source ↗
                </a>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Refresh button shared by the card and the page. */
export function RefreshNewsButton({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const [note, setNote] = React.useState<string | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/dashboard/ceo/news/refresh", { method: "POST" });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Refresh failed");
      return json.data as { inserted: number; classified: number };
    },
    onSuccess: (d) => {
      setNote(`${d.inserted} new, ${d.classified} tagged`);
      qc.invalidateQueries({ queryKey: NEWS_QUERY_KEY });
    },
    onError: (e: Error) => setNote(e.message),
  });
  React.useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(t);
  }, [note]);
  return (
    <div className="flex items-center gap-2">
      {note && <span className="text-[11px] text-gray-500">{note}</span>}
      <button
        type="button"
        onClick={() => m.mutate()}
        disabled={m.isPending}
        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        title="Fetch the feeds now (at most once every 15 minutes)"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${m.isPending ? "animate-spin text-brand-600" : ""}`} />
        {compact ? null : m.isPending ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}

export function GreenNewsCard() {
  const { data, isLoading, error } = useQuery<NewsFeedResponse>({
    queryKey: [...NEWS_QUERY_KEY, "top"],
    queryFn: () => fetchNews("top=1"),
    staleTime: 10 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
  });

  const updated = data?.lastRun?.finished_at ?? data?.lastRun?.started_at ?? null;

  return (
    <div data-testid="ceo-green-news" className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
        <div className="flex items-start gap-2">
          <Newspaper className="mt-0.5 h-4 w-4 text-brand-600" />
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Green Energy Today</h3>
            <p className="text-xs text-gray-500">
              World + India: policy &amp; subsidies, funding, EV &amp; batteries, grid &amp; storage, who is
              making money and how. Refreshes every 2 hours.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {updated && (
            <span className="text-[11px] text-gray-400">
              Updated {timeAgo(updated)}
              {data?.lastRun?.status === "failed" ? " · last run failed" : ""}
            </span>
          )}
          <RefreshNewsButton />
          <Link
            href="/ceo/news"
            className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline"
          >
            View all <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </div>

      {error ? (
        <p className="text-xs text-rose-600">{(error as Error).message}</p>
      ) : isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 animate-pulse">
          <div className="lg:col-span-2 space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-4 bg-gray-100 rounded" />
            ))}
          </div>
          <div className="lg:col-span-3 space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 bg-gray-50 rounded-xl" />
            ))}
          </div>
        </div>
      ) : data && !data.enabled ? (
        <p className="text-xs text-gray-500">
          The news feed is switched off (app_settings › green_news). Nothing is being fetched.
        </p>
      ) : data && data.items.length === 0 && !data.brief ? (
        <div className="py-8 text-center">
          <Newspaper className="w-8 h-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-500">No stories yet</p>
          <p className="text-xs text-gray-400 mt-1">
            The first fetch runs within 30 minutes of the server starting, or press Refresh.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <div className="lg:col-span-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-3">
              Morning brief{data?.brief ? ` · ${istDayLabel(data.brief.brief_date)}` : ""}
            </p>
            {data?.brief ? (
              <BriefBullets brief={data.brief} />
            ) : (
              <p className="text-xs text-gray-500 leading-relaxed">
                Today&apos;s brief is written by the first refresh after 06:00 IST, once there are enough
                stories to summarise.
              </p>
            )}
          </div>
          <div className="lg:col-span-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-3">
              Top stories · last 24 h
            </p>
            <div className="space-y-2">
              {data?.items.map((it) => (
                <HeadlineRow key={it.id} item={it} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
