"use client";

/**
 * The dashboard "action center" strip — a compact row of chips answering "what
 * needs my attention right now", each linking to the filtered list. Role-scoped
 * counts come from the shared summary query (same one the sidebar badges use),
 * so this adds no extra request.
 *
 * Renders nothing until the summary has loaded (actions === []); once loaded,
 * shows only the non-zero chips, or a quiet "all caught up" when everything is
 * clear — so its presence always means something.
 */

import Link from "next/link";

import { useBuybackNotificationSummary } from "@/hooks/useBuybackNotificationSummary";

export default function BuybackActionCenter({ className }: { className?: string }) {
  const { actions } = useBuybackNotificationSummary();

  if (actions.length === 0) return null; // not loaded yet, or no buyback surface

  const live = actions.filter((a) => a.count > 0);

  if (live.length === 0) {
    return (
      <div className={`text-[12.5px] font-medium text-slate-400 ${className ?? ""}`}>
        You&apos;re all caught up — nothing needs action.
      </div>
    );
  }

  return (
    <div className={`flex flex-wrap gap-2 ${className ?? ""}`}>
      {live.map((a) => (
        <Link
          key={a.key}
          href={a.href}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12.5px] font-semibold text-slate-700 shadow-sm transition-all hover:border-slate-300 hover:shadow"
        >
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-sky-100 px-1.5 text-[11px] font-bold text-sky-700">
            {a.count > 99 ? "99+" : a.count}
          </span>
          {a.label}
        </Link>
      ))}
    </div>
  );
}
