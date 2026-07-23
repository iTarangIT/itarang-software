"use client";

/**
 * The shared notification row list — used by the bell dropdown (dense) and by
 * the full notification pages (with row actions). Category icon + priority
 * colour come straight from the row's derived `category`/`priority` (see
 * lib/buyback/notification-meta), so the taxonomy has exactly one home.
 *
 * States: loading (skeleton), error, empty — a notification surface must never
 * render a blank void that could be mistaken for "nothing happened".
 */

import type { LucideIcon } from "lucide-react";
import {
  Archive,
  ArchiveRestore,
  Check,
  ClipboardList,
  FileSpreadsheet,
  Handshake,
  Receipt,
  Recycle,
  Settings2,
  Trash2,
  Truck,
  Wallet,
} from "lucide-react";

import type { NotificationCategory, NotificationPriority } from "@/lib/buyback/notification-meta";
import type { BuybackNote } from "@/hooks/useBuybackNotifications";

const CATEGORY_META: Record<NotificationCategory, { icon: LucideIcon; tint: string; fg: string }> = {
  Negotiation: { icon: Handshake, tint: "bg-violet-50", fg: "text-violet-600" },
  "Buyback Requests": { icon: Recycle, tint: "bg-emerald-50", fg: "text-emerald-600" },
  Quotations: { icon: FileSpreadsheet, tint: "bg-sky-50", fg: "text-sky-600" },
  "Purchase Orders": { icon: ClipboardList, tint: "bg-indigo-50", fg: "text-indigo-600" },
  Invoices: { icon: Receipt, tint: "bg-amber-50", fg: "text-amber-600" },
  Payments: { icon: Wallet, tint: "bg-green-50", fg: "text-green-600" },
  Pickup: { icon: Truck, tint: "bg-blue-50", fg: "text-blue-600" },
  System: { icon: Settings2, tint: "bg-slate-100", fg: "text-slate-500" },
};

const PRIORITY_META: Record<NotificationPriority, { cls: string }> = {
  Info: { cls: "bg-slate-100 text-slate-600" },
  Warning: { cls: "bg-amber-100 text-amber-700" },
  Critical: { cls: "bg-red-100 text-red-700" },
};

export function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

export interface NotificationListProps {
  items: BuybackNote[];
  loading?: boolean;
  error?: boolean;
  /** Bell dropdown (compact, no action buttons) vs. full page. */
  dense?: boolean;
  emptyLabel?: string;
  onOpen: (n: BuybackNote) => void;
  onMarkRead?: (n: BuybackNote) => void;
  onArchive?: (n: BuybackNote) => void;
  onUnarchive?: (n: BuybackNote) => void;
  onDelete?: (n: BuybackNote) => void;
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
    >
      {children}
    </button>
  );
}

function Row({ n, dense, onOpen, onMarkRead, onArchive, onUnarchive, onDelete }: {
  n: BuybackNote;
} & Omit<NotificationListProps, "items" | "loading" | "error" | "emptyLabel">) {
  const isUnread = n.read !== true;
  const meta = CATEGORY_META[n.category] ?? CATEGORY_META.System;
  const Icon = meta.icon;

  return (
    <li className="group">
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(n)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(n);
          }
        }}
        className={`flex w-full cursor-pointer gap-3 border-b border-gray-50 px-4 ${
          dense ? "py-3" : "py-3.5"
        } text-left transition-colors hover:bg-slate-50 ${isUnread ? "bg-sky-50/40" : ""}`}
      >
        <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${meta.tint} ${meta.fg}`}>
          <Icon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {isUnread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />}
            <span className={`block truncate text-[12.5px] ${isUnread ? "font-bold" : "font-semibold"} text-slate-900`}>
              {n.title}
            </span>
            {n.priority !== "Info" && (
              <span className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${PRIORITY_META[n.priority].cls}`}>
                {n.priority}
              </span>
            )}
          </div>

          <p className={`mt-0.5 text-[11.5px] text-slate-500 ${dense ? "truncate" : "line-clamp-2"}`}>{n.message}</p>

          <div className="mt-1 flex items-center gap-2">
            <span className="text-[10.5px] font-medium text-slate-400">{n.category}</span>
            <span className="text-[10.5px] text-slate-300">·</span>
            <span className="text-[10.5px] text-slate-400">{timeAgo(n.created_at)}</span>
            {!n.href && <span className="text-[10.5px] text-slate-300">· no linked page</span>}

            {!dense && (
              <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                {isUnread && onMarkRead && (
                  <IconButton label="Mark read" onClick={() => onMarkRead(n)}>
                    <Check className="h-3.5 w-3.5" />
                  </IconButton>
                )}
                {onUnarchive && n.archived_at && (
                  <IconButton label="Unarchive" onClick={() => onUnarchive(n)}>
                    <ArchiveRestore className="h-3.5 w-3.5" />
                  </IconButton>
                )}
                {onArchive && !n.archived_at && (
                  <IconButton label="Archive" onClick={() => onArchive(n)}>
                    <Archive className="h-3.5 w-3.5" />
                  </IconButton>
                )}
                {onDelete && (
                  <IconButton label="Delete" onClick={() => onDelete(n)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                )}
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export default function NotificationList(props: NotificationListProps) {
  const { items, loading, error, dense, emptyLabel = "Nothing here yet." } = props;

  if (loading && items.length === 0) {
    return (
      <ul className="divide-y divide-gray-50">
        {Array.from({ length: dense ? 4 : 6 }).map((_, i) => (
          <li key={i} className="flex gap-3 px-4 py-3.5">
            <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-slate-100" />
            <div className="flex-1 space-y-2">
              <div className="h-2.5 w-1/2 animate-pulse rounded bg-slate-100" />
              <div className="h-2.5 w-3/4 animate-pulse rounded bg-slate-100" />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (error) {
    return (
      <p className="px-4 py-8 text-center text-[12.5px] text-slate-400">
        Couldn&apos;t load notifications. They&apos;ll reappear on the next refresh.
      </p>
    );
  }

  if (items.length === 0) {
    return <p className="px-4 py-10 text-center text-[12.5px] text-slate-400">{emptyLabel}</p>;
  }

  return (
    <ul>
      {items.map((n) => (
        <Row key={n.id} n={n} {...props} />
      ))}
    </ul>
  );
}
