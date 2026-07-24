"use client";

/**
 * The CRM-wide notification row list.
 *
 * Role-agnostic: every row already carries its own role-correct `href`, its
 * provenance pair and its available actions from the API, so this one component
 * serves the admin, dealer, NBFC and vendor pages — each page only wraps it in
 * its own chrome.
 *
 * Two things this renders that the buyback list did not:
 *  - THE PROVENANCE LINE ("Bajaj Finance → iTarang Admin · Field
 *    Investigation"). Without it a hand-off chain is unreadable: the same
 *    request legitimately bounces NBFC → admin → dealer → admin → NBFC and the
 *    title alone cannot say who raised it or who is holding it now.
 *  - INLINE ACTIONS. One-click decisions (Forward to dealer, Push to NBFC,
 *    Decline) fired straight from the row against ordinary session-authenticated
 *    endpoints. Anything needing input carries `opensHref` and just navigates.
 *
 * States: loading (skeleton), error, empty — a notification surface must never
 * render a blank void that could be mistaken for "nothing happened".
 */

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  ArchiveRestore,
  BadgeCheck,
  Boxes,
  Check,
  ClipboardList,
  FileSignature,
  FileSpreadsheet,
  Handshake,
  Landmark,
  Loader2,
  MapPin,
  Megaphone,
  PackageCheck,
  Receipt,
  Recycle,
  Repeat,
  Settings2,
  ShieldCheck,
  Trash2,
  Truck,
  UserPlus,
  Video,
  Wallet,
} from "lucide-react";

import type { Note, NoteAction } from "@/hooks/useNotifications";
import type { NotificationCategory, NotificationPriority } from "@/lib/notifications/catalog";

const CATEGORY_META: Record<NotificationCategory, { icon: LucideIcon; tint: string; fg: string }> = {
  // CRM-wide
  Leads: { icon: UserPlus, tint: "bg-sky-50", fg: "text-sky-600" },
  Onboarding: { icon: BadgeCheck, tint: "bg-teal-50", fg: "text-teal-600" },
  "KYC & Consent": { icon: ShieldCheck, tint: "bg-indigo-50", fg: "text-indigo-600" },
  "NBFC Requests": { icon: Repeat, tint: "bg-violet-50", fg: "text-violet-600" },
  "Field Investigation": { icon: MapPin, tint: "bg-orange-50", fg: "text-orange-600" },
  "Video KYC": { icon: Video, tint: "bg-fuchsia-50", fg: "text-fuchsia-600" },
  "E-NACH": { icon: FileSignature, tint: "bg-cyan-50", fg: "text-cyan-600" },
  Agreements: { icon: FileSignature, tint: "bg-blue-50", fg: "text-blue-600" },
  "Loan & Sanction": { icon: Landmark, tint: "bg-emerald-50", fg: "text-emerald-600" },
  "Product & Dispatch": { icon: PackageCheck, tint: "bg-lime-50", fg: "text-lime-700" },
  Inventory: { icon: Boxes, tint: "bg-amber-50", fg: "text-amber-600" },
  Escalations: { icon: Megaphone, tint: "bg-rose-50", fg: "text-rose-600" },
  // Buyback's own eight, unchanged
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

/** "Bajaj Finance → iTarang Admin · Field Investigation", when we know it. */
export function provenanceOf(n: Note): string | null {
  const from = n.from?.label;
  const to = n.to?.label;
  if (!from && !to) return n.stage ?? null;
  const base = `${from ?? "—"} → ${to ?? "—"}`;
  return n.stage ? `${base} · ${n.stage}` : base;
}

export interface NotificationListProps {
  items: Note[];
  loading?: boolean;
  error?: boolean;
  emptyLabel?: string;
  onOpen: (n: Note) => void;
  onMarkRead?: (n: Note) => void;
  onArchive?: (n: Note) => void;
  onUnarchive?: (n: Note) => void;
  onDelete?: (n: Note) => void;
  /** Fires an inline action; resolves to true when it succeeded. */
  onAction?: (n: Note, a: NoteAction) => Promise<boolean>;
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
      className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
    >
      {children}
    </button>
  );
}

function ActionButtons({
  n,
  onAction,
}: {
  n: Note;
  onAction: (n: Note, a: NoteAction) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [result, setResult] = useState<Record<number, string>>({});
  const actions = (n.actions ?? []).slice(0, 3);
  if (actions.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {actions.map((a, i) => {
        if (result[i]) {
          return (
            <span key={i} className="text-[11px] font-semibold text-slate-500">
              {result[i]}
            </span>
          );
        }
        return (
          <button
            key={i}
            type="button"
            disabled={busy === i}
            onClick={async (e) => {
              e.stopPropagation();
              if (a.confirm && !window.confirm(a.confirm)) return;
              setBusy(i);
              try {
                const ok = await onAction(n, a);
                if (!a.opensHref) {
                  setResult((r) => ({ ...r, [i]: ok ? (a.successLabel ?? "Done") : "Failed" }));
                }
              } finally {
                setBusy(null);
              }
            }}
            className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
              a.variant === "danger"
                ? "border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                : a.variant === "neutral"
                  ? "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  : "bg-slate-800 text-white hover:bg-slate-900"
            }`}
          >
            {busy === i && <Loader2 className="h-3 w-3 animate-spin" />}
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

function Row({
  n,
  onOpen,
  onMarkRead,
  onArchive,
  onUnarchive,
  onDelete,
  onAction,
}: { n: Note } & Omit<NotificationListProps, "items" | "loading" | "error" | "emptyLabel">) {
  const isUnread = n.read !== true;
  const meta = CATEGORY_META[n.category] ?? CATEGORY_META.System;
  const Icon = meta.icon;
  const line = provenanceOf(n);

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
        className={`flex w-full cursor-pointer gap-3 border-b border-gray-50 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 ${
          isUnread ? "bg-sky-50/40" : ""
        }`}
      >
        <span
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${meta.tint} ${meta.fg}`}
        >
          <Icon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {isUnread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />}
            <span
              className={`block truncate text-[12.5px] ${isUnread ? "font-bold" : "font-semibold"} text-slate-900`}
            >
              {n.title}
            </span>
            {n.priority !== "Info" && (
              <span
                className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${PRIORITY_META[n.priority].cls}`}
              >
                {n.priority}
              </span>
            )}
          </div>

          <p className="mt-0.5 line-clamp-2 text-[11.5px] text-slate-500">{n.message}</p>

          {line && (
            <p className="mt-1 truncate text-[10.5px] font-medium text-slate-400">{line}</p>
          )}

          <div className="mt-1 flex items-center gap-2">
            <span className="text-[10.5px] font-medium text-slate-400">{n.category}</span>
            <span className="text-[10.5px] text-slate-300">·</span>
            <span className="text-[10.5px] text-slate-400">{timeAgo(n.created_at)}</span>
            {!n.href && <span className="text-[10.5px] text-slate-300">· no linked page</span>}

            <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
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
          </div>

          {onAction && <ActionButtons n={n} onAction={onAction} />}
        </div>
      </div>
    </li>
  );
}

export default function NotificationList(props: NotificationListProps) {
  const { items, loading, error, emptyLabel = "Nothing here yet." } = props;

  if (loading && items.length === 0) {
    return (
      <ul className="divide-y divide-gray-50">
        {Array.from({ length: 6 }).map((_, i) => (
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
