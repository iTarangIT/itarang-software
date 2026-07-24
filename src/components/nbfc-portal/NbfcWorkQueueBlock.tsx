"use client";

/**
 * The NBFC bell's live work-queue summary — "Needs attention" counts per track
 * plus the last 24h of successes.
 *
 * This used to BE the NBFC bell: a counts-only dropdown with no events, no read
 * state and no history, which is why an NBFC user never saw a notification for
 * anything that actually happened on a lead. The bell is now the shared
 * `NotificationBell` for every portal; this block was kept verbatim and is
 * rendered ABOVE the feed as its `headerSlot`, so the at-a-glance pipeline view
 * survives rather than being traded away for the feed.
 *
 * Derived state, not notifications: these counts come from the live pipeline
 * (`useNbfcWorkQueue`) and clear themselves when the work is done — no marking
 * read, no dismissing.
 */
import Link from "next/link";
import { CheckCircle2, FileSignature, FileText, Inbox, MapPin, Video } from "lucide-react";

import { useNbfcWorkQueue } from "@/hooks/useNbfcWorkQueue";

/** Compact "2h ago" style relative time for recent-activity rows. */
function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function NbfcWorkQueueBlock({ onNavigate }: { onNavigate?: () => void }) {
  const wq = useNbfcWorkQueue();

  // One row per track. Hidden when its count is 0; each deep-links to the
  // Acquire pipeline pre-filtered to exactly the leads that need that action.
  const items = [
    { key: "pending", label: "New applications", count: wq.acquire_pending, href: "/nbfc/acquire?status=pending", icon: Inbox },
    { key: "fi", label: "Field Investigation to review", count: wq.fi, href: "/nbfc/acquire?need=fi", icon: MapPin },
    { key: "vkyc", label: "Video KYC pending", count: wq.vkyc, href: "/nbfc/acquire?need=vkyc", icon: Video },
    { key: "enach", label: "E-NACH pending", count: wq.enach, href: "/nbfc/acquire?need=enach", icon: FileSignature },
    { key: "agreement", label: "Agreement pending", count: wq.agreement, href: "/nbfc/acquire?need=agreement", icon: FileText },
  ].filter((i) => i.count > 0);

  if (items.length === 0 && wq.recent.length === 0) return null;

  return (
    <div className="border-b border-gray-100 bg-slate-50/60">
      {items.length > 0 && (
        <div className="py-1">
          <div className="flex items-center justify-between px-4 pt-1.5 pb-1">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
              Needs attention
            </p>
            <span className="text-[11px] tabular-nums text-gray-400">{wq.attention_total} open</span>
          </div>
          {items.map((i) => {
            const Icon = i.icon;
            return (
              <Link
                key={i.key}
                href={i.href}
                onClick={onNavigate}
                className="flex items-center gap-3 px-4 py-2 text-[12.5px] text-gray-700 transition-colors hover:bg-white"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-gray-500">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">{i.label}</span>
                <span className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-full bg-[color:var(--color-brand-sky)] px-1.5 text-[10.5px] font-bold tabular-nums text-white">
                  {i.count > 99 ? "99+" : i.count}
                </span>
              </Link>
            );
          })}
        </div>
      )}

      {wq.recent.length > 0 && (
        <div className="border-t border-gray-100 py-1">
          <p className="px-4 pt-1.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-gray-400">
            Recent activity
          </p>
          {wq.recent.map((e, idx) => {
            const isAgreement = e.type === "agreement";
            const Icon = isAgreement ? FileText : Video;
            const label = isAgreement ? "Agreement signed" : "Video KYC submitted";
            return (
              <Link
                key={`${e.type}-${e.lead_id}-${idx}`}
                href={`/nbfc/acquire/${e.lead_id}`}
                onClick={onNavigate}
                className="flex items-center gap-3 px-4 py-2 text-[12.5px] text-gray-700 transition-colors hover:bg-white"
              >
                <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                  <Icon className="h-3.5 w-3.5" />
                  <CheckCircle2 className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-white text-emerald-500" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-gray-800">{label}</span>
                  <span className="block truncate text-[11px] text-gray-500">
                    {e.customer_name || e.lead_id}
                  </span>
                </span>
                <span className="shrink-0 text-[10.5px] text-gray-400">{relativeTime(e.at)}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
