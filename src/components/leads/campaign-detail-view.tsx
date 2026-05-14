// Drill-in view for a single dialer campaign. Mirrors the structure of
// src/components/scraper/RunDetailView.tsx: back link, header with status
// badge + chips, four stats cards, tab switcher for lead buckets, paginated
// lead table, and an Excel export button.

"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  ArrowLeft,
  Download,
  Phone,
  TrendingUp,
  MapPin,
  Loader2,
  Users,
  PhoneCall,
  CheckCircle2,
  XCircle,
  Clock,
} from "lucide-react";
import {
  CampaignLeadStatusBadge,
  CampaignOutcomeBadge,
  CampaignStatusBadge,
} from "./campaign-status-badge";
import { describeRegion, displayCampaignName } from "@/lib/leads/regionSummary";

type Campaign = {
  id: string;
  name: string;
  status: string;
  provider: string;
  category: string | null;
  regionFilter: unknown;
  totalLeads: number;
  callsMade: number;
  completedLeads: number;
  failedLeads: number;
  startedAt: string | null;
  completedAt: string | null;
  triggeredBy: string | null;
  triggeredByName: string | null;
};

type Lead = {
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

type Bucket = "all" | "pending" | "calling" | "completed" | "failed";

const BUCKET_LABELS: Record<Bucket, string> = {
  all: "All",
  pending: "Pending",
  calling: "Calling",
  completed: "Completed",
  failed: "Failed",
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatCard({
  label,
  value,
  Icon,
  tone,
}: {
  label: string;
  value: number | string;
  Icon: any;
  tone: "neutral" | "emerald" | "amber" | "rose" | "blue";
}) {
  const toneClass = {
    neutral: "bg-gray-50 text-gray-700 border-gray-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    rose: "bg-rose-50 text-rose-700 border-rose-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  }[tone];
  return (
    <div className={`rounded-xl border px-4 py-3 ${toneClass}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider opacity-80">
          {label}
        </span>
        <Icon className="w-4 h-4 opacity-70" />
      </div>
      <p className="text-2xl font-bold mt-1 tabular-nums">{value}</p>
    </div>
  );
}

function LeadRow({ row, index }: { row: Lead; index: number }) {
  const name = row.shopName || row.dealerName || `Lead ${row.queuePosition + 1}`;
  return (
    <tr className={`border-t border-gray-100 ${index % 2 === 0 ? "bg-white" : "bg-gray-50/50"}`}>
      <td className="px-3 py-2.5 text-xs font-mono text-gray-500 w-12">
        #{row.queuePosition + 1}
      </td>
      <td className="px-3 py-2.5">
        <p className="font-medium text-gray-900 text-sm">{name}</p>
        {row.phone && (
          <p className="text-[11px] text-gray-500 flex items-center gap-1 mt-0.5">
            <Phone className="w-2.5 h-2.5" /> {row.phone}
          </p>
        )}
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-600">
        {row.city || row.state ? (
          <span className="inline-flex items-center gap-1">
            <MapPin className="w-2.5 h-2.5" />
            {[row.city, row.state].filter(Boolean).join(", ")}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2.5">
        <CampaignLeadStatusBadge status={row.status} />
      </td>
      <td className="px-3 py-2.5">
        <CampaignOutcomeBadge outcome={row.callOutcome} />
      </td>
      <td className="px-3 py-2.5 text-xs">
        {row.intentScore != null ? (
          <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
            <TrendingUp className="w-3 h-3" /> {row.intentScore}
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-500">{fmt(row.startedAt)}</td>
      <td className="px-3 py-2.5 text-xs text-gray-500">{fmt(row.completedAt)}</td>
    </tr>
  );
}

export function CampaignDetailView({
  campaignId,
  onBack,
}: {
  campaignId: string;
  onBack?: () => void;
}) {
  const [bucket, setBucket] = useState<Bucket>("all");
  const [page, setPage] = useState(1);

  const { data: campaign, isLoading: campaignLoading } = useQuery<Campaign>({
    queryKey: ["dialer-campaign", campaignId],
    queryFn: async () => {
      const res = await fetch(`/api/ai-dialer/campaigns/${campaignId}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Failed");
      return json.data as Campaign;
    },
    refetchInterval: (query) => {
      const c = query.state.data as Campaign | undefined;
      return c?.status === "running" ? 4000 : false;
    },
  });

  const isRunning = campaign?.status === "running";

  const { data: leadsData, isLoading: leadsLoading } = useQuery({
    queryKey: ["dialer-campaign-leads", campaignId, bucket, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        bucket,
        page: String(page),
      });
      const res = await fetch(
        `/api/ai-dialer/campaigns/${campaignId}/leads?${params}`,
      );
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Failed");
      return json.data;
    },
    refetchInterval: isRunning ? 4000 : false,
  });

  if (campaignLoading || !campaign) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Loading campaign…
      </div>
    );
  }

  // bucket=all returns { pending, calling, completed, failed } maps; the
  // detail page flattens them into one combined list for the All view.
  const rawLeads = leadsData?.data ?? leadsData ?? null;
  const flatLeads: Lead[] = (() => {
    if (Array.isArray(rawLeads)) return rawLeads as Lead[];
    if (rawLeads && typeof rawLeads === "object") {
      const r = rawLeads as any;
      return [
        ...(r.pending ?? []),
        ...(r.calling ?? []),
        ...(r.completed ?? []),
        ...(r.failed ?? []),
      ] as Lead[];
    }
    return [];
  })();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        {onBack ? (
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Campaigns
          </button>
        ) : (
          <Link
            href="/leads?tab=campaigns"
            className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Campaigns
          </Link>
        )}
        <a
          href={`/api/ai-dialer/campaigns/${campaignId}/export.xlsx`}
          download
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white"
        >
          <Download className="w-4 h-4" /> Export Excel
        </a>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold text-gray-900 tracking-tight">
              {displayCampaignName({
                category: campaign.category,
                regionFilter: campaign.regionFilter,
                startedAt: campaign.startedAt,
              })}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <CampaignStatusBadge status={campaign.status} />
              <span className="px-2 py-0.5 rounded-full font-medium bg-zinc-100 text-zinc-700">
                {campaign.provider === "elevenlabs" ? "ElevenLabs" : "Bolna"}
              </span>
              {campaign.category && (
                <span className="px-2 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700">
                  {campaign.category}
                </span>
              )}
              <span className="text-gray-500 inline-flex items-center gap-1">
                <MapPin className="w-3 h-3" />
                {describeRegion(campaign.regionFilter)}
              </span>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              Triggered by{" "}
              <span className="font-medium text-gray-700">
                {campaign.triggeredByName ?? "—"}
              </span>{" "}
              · Started {fmt(campaign.startedAt)}
              {campaign.completedAt && ` · Ended ${fmt(campaign.completedAt)}`}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Total leads"
          value={campaign.totalLeads}
          Icon={Users}
          tone="neutral"
        />
        <StatCard
          label="Calls made"
          value={campaign.callsMade}
          Icon={PhoneCall}
          tone="blue"
        />
        <StatCard
          label="Completed"
          value={campaign.completedLeads}
          Icon={CheckCircle2}
          tone="emerald"
        />
        <StatCard
          label="Failed"
          value={campaign.failedLeads}
          Icon={XCircle}
          tone="rose"
        />
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
        <div className="flex items-center gap-1 border-b border-gray-100 px-4 pt-3">
          {(Object.keys(BUCKET_LABELS) as Bucket[]).map((b) => {
            const isActive = bucket === b;
            return (
              <button
                key={b}
                onClick={() => {
                  setBucket(b);
                  setPage(1);
                }}
                className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                  isActive
                    ? "border-emerald-600 text-emerald-700"
                    : "border-transparent text-gray-500 hover:text-gray-800"
                }`}
              >
                {BUCKET_LABELS[b]}
              </button>
            );
          })}
        </div>

        {leadsLoading ? (
          <div className="py-16 flex items-center justify-center text-gray-500">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            Loading leads…
          </div>
        ) : flatLeads.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">
            <Clock className="w-5 h-5 mx-auto mb-2 text-gray-300" />
            No leads in this bucket
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-2.5 text-left font-semibold">#</th>
                  <th className="px-3 py-2.5 text-left font-semibold">Lead</th>
                  <th className="px-3 py-2.5 text-left font-semibold">
                    Location
                  </th>
                  <th className="px-3 py-2.5 text-left font-semibold">
                    Status
                  </th>
                  <th className="px-3 py-2.5 text-left font-semibold">
                    Outcome
                  </th>
                  <th className="px-3 py-2.5 text-left font-semibold">
                    Intent
                  </th>
                  <th className="px-3 py-2.5 text-left font-semibold">
                    Started
                  </th>
                  <th className="px-3 py-2.5 text-left font-semibold">
                    Ended
                  </th>
                </tr>
              </thead>
              <tbody>
                {flatLeads.map((row, i) => (
                  <LeadRow key={row.id} row={row} index={i} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {bucket !== "all" && (
          <div className="flex justify-between items-center px-4 py-3 border-t border-gray-100">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm disabled:opacity-50 hover:bg-gray-50"
            >
              Previous
            </button>
            <span className="text-sm text-gray-600">Page {page}</span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={flatLeads.length < 50}
              className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm disabled:opacity-50 hover:bg-gray-50"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
