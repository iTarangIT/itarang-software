// Drill-in view for a single dialer campaign. Mirrors the structure of
// src/components/scraper/RunDetailView.tsx: back link, header with status
// badge + chips, four stats cards, tab switcher for lead buckets, paginated
// lead table, and an Excel export button.

"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  StopCircle,
  PhoneOutgoing,
  RotateCcw,
} from "lucide-react";
import { CampaignLeadTranscriptDrawer } from "./CampaignLeadTranscriptDrawer";
import {
  CampaignLeadStatusBadge,
  CampaignOutcomeBadge,
  CampaignStatusBadge,
} from "./campaign-status-badge";
import { describeRegion, displayCampaignName } from "@/lib/leads/regionSummary";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";

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
  /** Derived server-side — see src/lib/ai-dialer/failureReason.ts. */
  failureReason?: {
    code: string;
    label: string;
    hint: string;
    detail: string | null;
    retryable: boolean;
    ourFault: boolean;
  } | null;
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
  durationSeconds: number | null;
  corrected: boolean;
  attemptCount: number;
  convertedOnAttempt: number | null;
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

// Exact call duration as "Xm YYs" — mirrors the drawer's fmtDuration so the
// table cell and the drawer header always read the same.
function fmtDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
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

function LeadRow({
  row,
  index,
  onSelect,
}: {
  row: Lead;
  index: number;
  onSelect: (leadId: string) => void;
}) {
  const name = row.shopName || row.dealerName || `Lead ${row.queuePosition + 1}`;
  return (
    <tr
      className={`border-t border-gray-100 cursor-pointer hover:bg-emerald-50/40 transition-colors ${
        index % 2 === 0 ? "bg-white" : "bg-gray-50/50"
      }`}
      onClick={() => onSelect(row.leadId)}
    >
      <td className="px-3 py-2.5 text-xs font-mono text-gray-500 w-12">
        #{row.queuePosition + 1}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <p className="font-medium text-gray-900 text-sm">{name}</p>
          {row.corrected && (
            <span
              className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-700 bg-emerald-100 rounded-full px-1.5 py-0.5"
              title="Intent score manually corrected"
            >
              <CheckCircle2 className="w-3 h-3" /> Corrected
            </span>
          )}
        </div>
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
        <CampaignOutcomeBadge
          outcome={row.callOutcome}
          failureReason={row.failureReason}
        />
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
      <td className="px-3 py-2.5 text-xs">
        {row.attemptCount > 0 ? (
          <span
            className="inline-flex items-center gap-1.5"
            title="Total dialer attempts for this lead across all campaigns (original + recalls)"
          >
            <span className="inline-flex items-center gap-1 font-medium text-gray-700 tabular-nums">
              <RotateCcw className="w-3 h-3 text-gray-400" />
              {row.attemptCount}×
            </span>
            {row.convertedOnAttempt != null && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-700 bg-emerald-100 rounded-full px-1.5 py-0.5"
                title={`Qualified on attempt ${row.convertedOnAttempt}`}
              >
                <CheckCircle2 className="w-3 h-3" />#{row.convertedOnAttempt}
              </span>
            )}
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-500">{fmt(row.startedAt)}</td>
      <td className="px-3 py-2.5 text-xs text-gray-700 tabular-nums">
        {fmtDuration(row.durationSeconds)}
      </td>
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
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  // Intent-score filter for the lead table. `intentMin` null = "Any" (off).
  // `intentStrict` toggles ">" vs ">=" so the ">0" preset means strictly
  // greater than zero, while the "N+" presets are inclusive. Filtering is
  // client-side over the already-loaded rows (a campaign is a bounded set and
  // the All tab loads every lead), and the matching count is shown as a badge.
  const [intentMin, setIntentMin] = useState<number | null>(null);
  const [intentStrict, setIntentStrict] = useState(false);
  const [intentCustom, setIntentCustom] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();

  const stopMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/ai-dialer/campaigns/${campaignId}/stop`, {
        method: "POST",
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Stop failed");
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dialer-campaign", campaignId] });
      queryClient.invalidateQueries({
        queryKey: ["dialer-campaign-leads", campaignId],
      });
    },
  });

  // Resume a stopped campaign: continue dialing the leads that were never
  // reached, in THIS same campaign (stats stay cumulative). The route flips it
  // back to running and advanceCampaign claims only 'pending' rows, so
  // completed/failed leads are never re-dialed. Failed leads are handled
  // separately by the "Retry failed leads" button.
  const resumeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/ai-dialer/campaigns/${campaignId}/resume`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? "Resume failed");
      return json.data;
    },
    onSuccess: () => {
      // Status flips to running → the campaign GET's refetchInterval re-enables
      // and the page resumes live 4s polling on its own.
      queryClient.invalidateQueries({ queryKey: ["dialer-campaign", campaignId] });
      queryClient.invalidateQueries({
        queryKey: ["dialer-campaign-leads", campaignId],
      });
    },
    onError: (err: unknown) => {
      window.alert(
        err instanceof Error ? err.message : "Could not resume campaign",
      );
    },
  });

  // Manual nudge to place the next pending call. Needed when the
  // watchdog swept a stalled 'calling' row but no webhook re-entered
  // advanceCampaign — the remaining pending leads would sit untouched
  // without this trigger.
  const advanceMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/ai-dialer/campaigns/${campaignId}/advance`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!json.success) {
        throw new Error(json.error?.message ?? "Advance failed");
      }
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dialer-campaign", campaignId] });
      queryClient.invalidateQueries({
        queryKey: ["dialer-campaign-leads", campaignId],
      });
    },
  });

  // Bundle this campaign's retryable failed leads into a BRAND-NEW campaign and
  // start dialing it. The source campaign is left untouched (its stats remain the
  // historical record). On success we navigate to the new campaign's detail page,
  // which mounts already "running" and polls every 4s — so calling status shows
  // live with no manual refresh.
  const retryMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/ai-dialer/campaigns/${campaignId}/recall-failed`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!json.success) {
        throw new Error(json.error?.message ?? "Retry failed");
      }
      return json.data as { campaignId: string; retryCount: number };
    },
    onSuccess: (data) => {
      // Refresh the campaign history list (if mounted) so the new retry campaign
      // appears, then jump straight to it to watch it dial.
      queryClient.invalidateQueries({ queryKey: ["dialer-campaigns"] });
      router.push(`/leads/campaigns/${data.campaignId}`);
    },
    onError: (err: unknown) => {
      toast.error(
        err instanceof Error ? err.message : "Could not retry failed leads",
      );
    },
  });

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
  // Leads never reached yet = total minus the two terminal buckets. (calls_made
  // == completed_leads by the counter logic, so completed is the right term.)
  const pendingLeads = campaign
    ? campaign.totalLeads - campaign.completedLeads - campaign.failedLeads
    : 0;
  const canResume =
    !isRunning && campaign?.status === "stopped" && pendingLeads > 0;

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

  // Apply the intent-score filter client-side. A null intentScore never
  // matches an active filter (it has no score yet). `filteredLeads` is what
  // the table renders and what the count badge reports.
  const intentActive = intentMin != null;
  const matchesIntent = (row: Lead): boolean => {
    if (intentMin == null) return true;
    const s = row.intentScore;
    if (s == null) return false;
    return intentStrict ? s > intentMin : s >= intentMin;
  };
  const filteredLeads = intentActive ? flatLeads.filter(matchesIntent) : flatLeads;

  // Value backing the preset <select>. Maps current filter state to an option.
  const intentSelectValue = intentCustom
    ? "custom"
    : intentMin == null
      ? "any"
      : intentMin === 0 && intentStrict
        ? "gt0"
        : [30, 50, 75].includes(intentMin) && !intentStrict
          ? String(intentMin)
          : "custom";

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
        <div className="flex items-center gap-2">
          {isRunning && (
            <button
              type="button"
              onClick={() => advanceMutation.mutate()}
              disabled={advanceMutation.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white"
              title="Place the next pending call in this campaign"
            >
              {advanceMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <PhoneOutgoing className="w-4 h-4" />
              )}
              Call next
            </button>
          )}
          {isRunning && (
            <button
              type="button"
              onClick={async () => {
                const ok = await confirmDialog({
                  title: "Force-stop this campaign?",
                  message: "In-flight calls will be marked failed.",
                  confirmText: "Force stop",
                  variant: "danger",
                });
                if (ok) {
                  stopMutation.mutate();
                }
              }}
              disabled={stopMutation.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-rose-600 hover:bg-rose-700 disabled:opacity-60 text-white"
            >
              {stopMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <StopCircle className="w-4 h-4" />
              )}
              Force stop
            </button>
          )}
          {canResume && (
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    `Resume calling ${pendingLeads} pending lead${
                      pendingLeads === 1 ? "" : "s"
                    } from where this campaign stopped?`,
                  )
                ) {
                  resumeMutation.mutate();
                }
              }}
              disabled={resumeMutation.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white"
              title="Continue dialing this campaign's un-called leads from where it stopped"
            >
              {resumeMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <PhoneOutgoing className="w-4 h-4" />
              )}
              Resume calling ({pendingLeads})
            </button>
          )}
          {!isRunning && campaign.failedLeads > 0 && (
            <button
              type="button"
              onClick={async () => {
                const ok = await confirmDialog({
                  title: `Retry ${campaign.failedLeads} failed lead${
                    campaign.failedLeads === 1 ? "" : "s"
                  }?`,
                  message:
                    "This starts a new campaign and begins calling them.",
                  confirmText: "Retry",
                });
                if (ok) {
                  retryMutation.mutate();
                }
              }}
              disabled={retryMutation.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white"
              title="Create a new campaign from this campaign's failed leads and start dialing"
            >
              {retryMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RotateCcw className="w-4 h-4" />
              )}
              Retry failed leads ({campaign.failedLeads})
            </button>
          )}
          <a
            href={`/api/ai-dialer/campaigns/${campaignId}/export.xlsx`}
            download
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            <Download className="w-4 h-4" /> Export Excel
          </a>
        </div>
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
        <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-4 pt-3">
          <div className="flex items-center gap-1">
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

          {/* Intent-score filter + live count of matching leads. */}
          <div className="flex items-center gap-2 pb-2">
            {intentActive && (
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700"
                title="Leads matching the intent filter"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                {filteredLeads.length} lead{filteredLeads.length === 1 ? "" : "s"}
              </span>
            )}
            <select
              value={intentSelectValue}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "custom") {
                  setIntentCustom(true);
                  setIntentStrict(false);
                } else if (v === "any") {
                  setIntentCustom(false);
                  setIntentStrict(false);
                  setIntentMin(null);
                } else if (v === "gt0") {
                  setIntentCustom(false);
                  setIntentStrict(true);
                  setIntentMin(0);
                } else {
                  setIntentCustom(false);
                  setIntentStrict(false);
                  setIntentMin(Number(v));
                }
              }}
              title="Filter leads by intent score"
              className="py-1.5 pl-3 pr-8 text-sm border border-gray-200 rounded-lg bg-white outline-none focus:border-gray-400 text-gray-700"
            >
              <option value="any">Intent: Any</option>
              <option value="gt0">Intent: &gt; 0</option>
              <option value="30">Intent: 30+</option>
              <option value="50">Intent: 50+</option>
              <option value="75">Intent: 75+</option>
              <option value="custom">Intent: Custom…</option>
            </select>
            {intentCustom && (
              <input
                type="number"
                min={0}
                max={100}
                value={intentMin ?? ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  setIntentMin(raw === "" ? null : Number(raw));
                }}
                placeholder="min"
                title="Minimum intent score (inclusive)"
                className="py-1.5 px-3 text-sm border border-gray-200 rounded-lg bg-white outline-none focus:border-gray-400 w-20"
              />
            )}
          </div>
        </div>

        {leadsLoading ? (
          <div className="py-16 flex items-center justify-center text-gray-500">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            Loading leads…
          </div>
        ) : filteredLeads.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">
            <Clock className="w-5 h-5 mx-auto mb-2 text-gray-300" />
            {flatLeads.length === 0
              ? "No leads in this bucket"
              : "No leads match this intent filter"}
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
                    Attempts
                  </th>
                  <th className="px-3 py-2.5 text-left font-semibold">
                    Started
                  </th>
                  <th className="px-3 py-2.5 text-left font-semibold">
                    Duration
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredLeads.map((row, i) => (
                  <LeadRow
                    key={row.id}
                    row={row}
                    index={i}
                    onSelect={setSelectedLeadId}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <CampaignLeadTranscriptDrawer
          campaignId={campaignId}
          leadId={selectedLeadId}
          onClose={() => setSelectedLeadId(null)}
        />

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
