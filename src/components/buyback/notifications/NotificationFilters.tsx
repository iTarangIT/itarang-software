"use client";

/**
 * Filter + search controls for the full notification pages. Status (All /
 * Unread / Read), an Active/Archived view toggle, category pills, and a client
 * search box. Purely presentational — the page owns the state and re-queries.
 */

import { Search } from "lucide-react";

import { CATEGORIES, type NotificationCategory } from "@/lib/buyback/notification-meta";

export type NotificationStatusFilter = "all" | "unread" | "read";
export type NotificationView = "active" | "archived";

export interface NotificationFiltersProps {
  status: NotificationStatusFilter;
  onStatus: (s: NotificationStatusFilter) => void;
  category: NotificationCategory | null;
  onCategory: (c: NotificationCategory | null) => void;
  search: string;
  onSearch: (s: string) => void;
  view: NotificationView;
  onView: (v: NotificationView) => void;
  /** Optional per-category unread counts, shown as pill badges. */
  counts?: Partial<Record<NotificationCategory, number>>;
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors ${
            value === o.key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function NotificationFilters({
  status,
  onStatus,
  category,
  onCategory,
  search,
  onSearch,
  view,
  onView,
  counts,
}: NotificationFiltersProps) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={status}
          onChange={onStatus}
          options={[
            { key: "all", label: "All" },
            { key: "unread", label: "Unread" },
            { key: "read", label: "Read" },
          ]}
        />
        <Segmented
          value={view}
          onChange={onView}
          options={[
            { key: "active", label: "Inbox" },
            { key: "archived", label: "Archived" },
          ]}
        />

        <div className="relative ml-auto min-w-[200px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search notifications…"
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-8 pr-3 text-[12.5px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-slate-300 focus:ring-2 focus:ring-slate-100"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Pill active={category === null} onClick={() => onCategory(null)} label="All categories" />
        {CATEGORIES.map((c) => (
          <Pill key={c} active={category === c} onClick={() => onCategory(c)} label={c} count={counts?.[c]} />
        ))}
      </div>
    </div>
  );
}

function Pill({
  label,
  active,
  onClick,
  count,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] font-semibold transition-colors ${
        active
          ? "border-slate-900 bg-slate-900 text-white"
          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900"
      }`}
    >
      {label}
      {count ? (
        <span
          className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold ${
            active ? "bg-white/20 text-white" : "bg-sky-100 text-sky-700"
          }`}
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </button>
  );
}
