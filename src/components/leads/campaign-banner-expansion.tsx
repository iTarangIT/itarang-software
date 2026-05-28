// The expandable panel that drops under the AI Dialer banner on /leads.
// Renders three columns (Pending / Calling / Completed) for the active
// campaign. Polls /api/ai-dialer/campaigns/[id]/leads?bucket=all every 2s
// while the campaign is running, then once after stop so the final state
// is visible.

"use client";

import { useEffect, useState } from "react";
import {
  Phone,
  TrendingUp,
  Loader2,
  CheckCircle2,
  Clock,
  PhoneCall,
  XCircle,
  ArrowUpRight,
} from "lucide-react";
import Link from "next/link";
import { CampaignOutcomeBadge } from "./campaign-status-badge";

type LeadRow = {
  id: string;
  leadId: string;
  queuePosition: number;
  status: string;
  callOutcome: string | null;
  intentScore: number | null;
  startedAt: string | null;
  completedAt: string | null;
  shopName: string | null;
  dealerName: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  finalIntentScore: number | null;
  currentStatus: string | null;
};

type AllBuckets = {
  pending: LeadRow[];
  calling: LeadRow[];
  completed: LeadRow[];
  failed: LeadRow[];
};

function leadName(r: LeadRow): string {
  return r.shopName || r.dealerName || `Lead ${r.queuePosition + 1}`;
}

function LeadCard({
  row,
  variant,
}: {
  row: LeadRow;
  variant: "pending" | "calling" | "completed" | "failed";
}) {
  const isCalling = variant === "calling";
  const isFailed = variant === "failed";
  const isCompleted = variant === "completed";

  return (
    <div
      className={`rounded-lg px-3 py-2.5 border transition-colors ${
        isCalling
          ? "border-emerald-500/40 bg-emerald-500/10"
          : isCompleted
            ? "border-blue-500/30 bg-blue-500/5"
            : isFailed
              ? "border-rose-500/30 bg-rose-500/5"
              : "border-gray-700 bg-gray-800/60"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-white truncate flex items-center gap-1.5">
            {isCalling && (
              <PhoneCall className="w-3 h-3 text-emerald-400 animate-pulse shrink-0" />
            )}
            {isCompleted && (
              <CheckCircle2 className="w-3 h-3 text-blue-400 shrink-0" />
            )}
            {isFailed && (
              <XCircle className="w-3 h-3 text-rose-400 shrink-0" />
            )}
            {variant === "pending" && (
              <Clock className="w-3 h-3 text-gray-500 shrink-0" />
            )}
            <span className="truncate">{leadName(row)}</span>
          </p>
          <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
            {row.phone && (
              <span className="flex items-center gap-1">
                <Phone className="w-2.5 h-2.5" />
                {row.phone}
              </span>
            )}
            {(row.city || row.state) && (
              <span className="text-gray-500">
                · {[row.city, row.state].filter(Boolean).join(", ")}
              </span>
            )}
          </p>
          {(isCompleted || isFailed) && (
            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
              <CampaignOutcomeBadge outcome={row.callOutcome} />
              {row.intentScore != null && (
                <span className="inline-flex items-center gap-0.5 text-[11px] text-emerald-400 font-medium">
                  <TrendingUp className="w-2.5 h-2.5" />
                  {row.intentScore}
                </span>
              )}
            </div>
          )}
        </div>
        {variant === "pending" && (
          <span className="text-[10px] font-mono text-gray-500 shrink-0">
            #{row.queuePosition + 1}
          </span>
        )}
      </div>
    </div>
  );
}

function ColumnHeader({
  label,
  count,
  Icon,
  color,
}: {
  label: string;
  count: number;
  Icon: any;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-2 px-1">
      <Icon className={`w-3.5 h-3.5 ${color}`} />
      <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-300">
        {label}
      </span>
      <span className="text-[11px] font-mono text-gray-500">({count})</span>
    </div>
  );
}

export function CampaignBannerExpansion({
  campaignId,
  active,
}: {
  campaignId: string;
  active: boolean;
}) {
  const [buckets, setBuckets] = useState<AllBuckets | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(
          `/api/ai-dialer/campaigns/${campaignId}/leads?bucket=all`,
        );
        const json = await res.json();
        if (cancelled) return;
        if (json?.success) {
          setBuckets(json.data as AllBuckets);
        }
      } catch (err) {
        console.error("[CampaignBannerExpansion] fetch failed", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    // Poll only while the campaign is running. We still call load() once on
    // mount above so the user sees the final state immediately after stop.
    const interval = active ? setInterval(load, 2000) : null;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [campaignId, active]);

  if (loading && !buckets) {
    return (
      <div className="mt-3 pt-3 border-t border-gray-700 flex items-center justify-center py-6 text-xs text-gray-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
        Loading campaign leads…
      </div>
    );
  }

  if (!buckets) return null;

  const pending = buckets.pending ?? [];
  const calling = buckets.calling ?? [];
  const completed = buckets.completed ?? [];
  const failed = buckets.failed ?? [];

  return (
    <div className="mt-3 pt-3 border-t border-gray-700">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="min-w-0">
          <ColumnHeader
            label="Pending"
            count={pending.length}
            Icon={Clock}
            color="text-gray-400"
          />
          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {pending.length === 0 ? (
              <p className="text-[11px] text-gray-500 italic px-1 py-2">
                Queue empty
              </p>
            ) : (
              pending.map((r) => (
                <LeadCard key={r.id} row={r} variant="pending" />
              ))
            )}
          </div>
        </div>

        <div className="min-w-0">
          <ColumnHeader
            label="Calling"
            count={calling.length}
            Icon={PhoneCall}
            color="text-emerald-400"
          />
          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {calling.length === 0 ? (
              <p className="text-[11px] text-gray-500 italic px-1 py-2">
                No live call
              </p>
            ) : (
              calling.map((r) => (
                <LeadCard key={r.id} row={r} variant="calling" />
              ))
            )}
          </div>
        </div>

        <div className="min-w-0">
          <ColumnHeader
            label={failed.length > 0 ? "Completed / Failed" : "Completed"}
            count={completed.length + failed.length}
            Icon={CheckCircle2}
            color="text-blue-400"
          />
          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {completed.length + failed.length === 0 ? (
              <p className="text-[11px] text-gray-500 italic px-1 py-2">
                Nothing finished yet
              </p>
            ) : (
              <>
                {completed.map((r) => (
                  <LeadCard key={r.id} row={r} variant="completed" />
                ))}
                {failed.map((r) => (
                  <LeadCard key={r.id} row={r} variant="failed" />
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <Link
          href={`/leads/campaigns/${campaignId}`}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-gray-400 hover:text-white transition-colors"
        >
          View full campaign <ArrowUpRight className="w-3 h-3" />
        </Link>
      </div>
    </div>
  );
}
