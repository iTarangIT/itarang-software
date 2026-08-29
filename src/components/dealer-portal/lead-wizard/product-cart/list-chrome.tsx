"use client";

import React, { useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Search, X } from "lucide-react";

/**
 * Presentational chrome shared by the battery and charger card grids —
 * filter chips, search box, pager, age badge, SOC bar, empty and loading
 * states. Moved out of the Step-4 page unchanged so both Step 4 (cash) and
 * Step 5 (finance) render an identical picker.
 */

export function FilterChip({
  label,
  active,
  tone = "blue",
  onClick,
}: {
  label: string;
  active: boolean;
  tone?: "blue" | "emerald" | "amber" | "red";
  onClick: () => void;
}) {
  const styles = active
    ? {
        blue: "bg-[#0047AB] text-white border-[#0047AB]",
        emerald: "bg-emerald-600 text-white border-emerald-600",
        amber: "bg-amber-500 text-white border-amber-500",
        red: "bg-red-500 text-white border-red-500",
      }[tone]
    : "bg-white text-gray-600 border-gray-200 hover:border-gray-300";
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-[11px] font-bold border-2 transition-all ${styles}`}
    >
      {label}
    </button>
  );
}

export function CardSearchBar({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative mb-3">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-9 pr-9 py-2 text-[12px] border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#0047AB]/20 focus:border-[#0047AB]"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// Compact pager for the card grids. Renders nothing when there's only one
// page; otherwise shows a "Showing X–Y of Z" line plus prev / page-numbers /
// next controls. Page numbers collapse to first / last + neighbors when there
// are many pages so the row stays a single line on mobile.
export function CardPagination({
  page,
  pageCount,
  total,
  pageSize,
  onChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onChange: (p: number) => void;
}) {
  if (pageCount <= 1) return null;

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  // Build a windowed list of page numbers: always show 1, last, and a window
  // around the current page. Insert a `null` as a "…" gap.
  const pages: (number | null)[] = [];
  const window = 1;
  for (let p = 1; p <= pageCount; p++) {
    if (p === 1 || p === pageCount || (p >= page - window && p <= page + window)) {
      pages.push(p);
    } else if (pages[pages.length - 1] !== null) {
      pages.push(null);
    }
  }

  return (
    <div className="mt-4 flex items-center justify-between flex-wrap gap-2">
      <span className="text-[11px] text-gray-500">
        Showing <strong className="text-gray-700">{start}</strong>–
        <strong className="text-gray-700">{end}</strong> of{" "}
        <strong className="text-gray-700">{total}</strong>
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page === 1}
          aria-label="Previous page"
          className="p-1.5 rounded-md border border-gray-200 text-gray-600 hover:border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        {pages.map((p, idx) =>
          p === null ? (
            <span key={`gap-${idx}`} className="px-1 text-[11px] text-gray-400">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              className={`min-w-[28px] px-2 py-1 rounded-md text-[11px] font-bold border transition-colors ${
                p === page
                  ? "bg-[#0047AB] text-white border-[#0047AB]"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
              }`}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => onChange(Math.min(pageCount, page + 1))}
          disabled={page === pageCount}
          aria-label="Next page"
          className="p-1.5 rounded-md border border-gray-200 text-gray-600 hover:border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export function AgeBadge({
  badge,
  days,
}: {
  badge: "fresh" | "ageing" | "old";
  days: number;
}) {
  const styles = {
    fresh: "bg-emerald-50 text-emerald-700 border-emerald-200",
    ageing: "bg-amber-50 text-amber-700 border-amber-200",
    old: "bg-red-50 text-red-700 border-red-200",
  }[badge];
  const label =
    badge === "fresh" ? "Fresh" : badge === "ageing" ? "Ageing" : "Old Stock";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-black ${styles}`}
    >
      <CalendarDays className="w-3 h-3" />
      {days}d · {label}
    </span>
  );
}

export function SocBar({
  socPercent,
  lastSyncAt,
}: {
  socPercent: string | null;
  lastSyncAt?: string | null;
}) {
  // "Now" is sampled once per mount through a lazy state initializer rather
  // than read during every render. Calling Date.now() inline made this
  // component impure, and made the server and the client compute different
  // sync labels for the same row — a hydration mismatch. Sampling once is
  // also enough: this label is measured in hours.
  const [nowMs] = useState(() => Date.now());

  if (socPercent == null) {
    return <div className="text-[11px] text-gray-400 font-medium">SOC: N/A</div>;
  }
  const n = Math.max(0, Math.min(100, Number(socPercent)));
  const tone = n >= 60 ? "emerald" : n >= 30 ? "amber" : "red";
  const barColor = {
    emerald: "bg-emerald-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
  }[tone];
  let syncLabel = "";
  let stale = false;
  if (lastSyncAt) {
    const diffMs = nowMs - new Date(lastSyncAt).getTime();
    if (Number.isFinite(diffMs) && diffMs >= 0) {
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      if (hours >= 24) {
        stale = true;
        syncLabel = `Last sync >24h ago — data may be outdated`;
      } else if (hours >= 1) {
        syncLabel = `Last sync: ${hours}h ago`;
      } else {
        syncLabel = `Last sync: just now`;
      }
    }
  }
  return (
    <div className="flex flex-col gap-1 w-full">
      <div className="flex items-center justify-between text-[10px] font-bold text-gray-600">
        <span>SOC</span>
        <span className={stale ? "text-amber-600" : "text-gray-700"}>{n}%</span>
      </div>
      <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all`}
          style={{ width: `${n}%` }}
        />
      </div>
      {syncLabel && (
        <span className={`text-[9px] ${stale ? "text-amber-600" : "text-gray-400"}`}>
          {syncLabel}
        </span>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <div className="mb-3">{icon}</div>
      <p className="text-sm font-bold text-gray-700">{title}</p>
      {hint && <p className="text-[11px] text-gray-400 mt-1 max-w-xs">{hint}</p>}
    </div>
  );
}

export function SkeletonCardGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="p-4 rounded-2xl border-2 border-gray-100 bg-white animate-pulse"
        >
          <div className="flex justify-between">
            <div className="space-y-2 flex-1">
              <div className="h-4 w-32 bg-gray-100 rounded" />
              <div className="h-3 w-24 bg-gray-100 rounded" />
            </div>
            <div className="h-5 w-16 bg-gray-100 rounded" />
          </div>
          <div className="mt-4 h-2 w-full bg-gray-100 rounded" />
        </div>
      ))}
    </div>
  );
}
