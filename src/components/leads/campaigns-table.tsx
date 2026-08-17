// Paginated history of AI dialer campaigns. Mirrors ScraperRunsTable for
// consistency — same React Query keys shape, same prefetch-on-hover, same
// "auto-refresh while any row is running" cadence.

"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import {
  CampaignStatusBadge,
} from "./campaign-status-badge";
import { displayCampaignName, summarizeRegion } from "@/lib/leads/regionSummary";

type CampaignRow = {
  id: string;
  // E-224 — which engine ran this campaign. 'ai_dialer' = Bolna/ElevenLabs
  // robot calls (dialer_campaigns); 'neodove' = human agents in NeoDove
  // (neodove_campaigns). The two live in separate tables and are UNIONed by
  // /api/campaigns/unified; see that route for why they aren't merged.
  kind?: "ai_dialer" | "neodove";
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
  totalTalkTimeSeconds: number | null;
};

// Total talk time across a campaign's calls, as "1h 03m" / "7m 12s" / "45s".
function fmtTalkTime(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

function categoryLabel(c: string | null): string {
  if (!c) return "All";
  const map: Record<string, string> = {
    hot: "Hot",
    warm: "Warm",
    cold: "Cold",
    all: "All",
    scheduled: "Scheduled",
  };
  return map[c] ?? c;
}

function providerChip(p: string) {
  if (p === "neodove") {
    return (
      <span className="px-2 py-0.5 text-[11px] font-medium rounded-full bg-purple-50 text-purple-700">
        NeoDove
      </span>
    );
  }
  if (p === "elevenlabs") {
    return (
      <span className="px-2 py-0.5 text-[11px] font-medium rounded-full bg-violet-50 text-violet-700">
        ElevenLabs
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 text-[11px] font-medium rounded-full bg-blue-50 text-blue-700">
      Bolna
    </span>
  );
}

export function CampaignsTable({
  /**
   * Where an AI-dialer row links to. Defaults to the admin console. The inside
   * sales and ASM dashboards mount this same table under their OWN prefix so
   * middleware keeps gating each dashboard to its role — a shared `/leads/*`
   * link would work, but its Back button lands the rep on the admin console.
   * NeoDove rows are unaffected: they have no per-dashboard detail view.
   */
  basePath = "/leads/campaigns",
}: {
  basePath?: string;
} = {}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);

  const prefetchCampaign = (id: string) => {
    queryClient.prefetchQuery({
      queryKey: ["dialer-campaign", id],
      queryFn: async () => {
        const res = await fetch(`/api/ai-dialer/campaigns/${id}`);
        const json = await res.json();
        if (!json.success) throw new Error(json.error?.message);
        return json.data;
      },
      staleTime: 30_000,
    });
    queryClient.prefetchQuery({
      queryKey: ["dialer-campaign-leads", id, "all", 1],
      queryFn: async () => {
        const res = await fetch(
          `/api/ai-dialer/campaigns/${id}/leads?bucket=all`,
        );
        const json = await res.json();
        if (!json.success) throw new Error(json.error?.message);
        return json.data;
      },
      staleTime: 30_000,
    });
  };

  const { data, isLoading, isError } = useQuery({
    // E-224 — unified list: AI-dialer campaigns AND NeoDove campaigns, so the
    // team has one place to look regardless of which engine ran the calls.
    queryKey: ["unified-campaigns", page],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/unified?page=${page}`);
      const json = await res.json();
      if (!json.success) throw new Error("Failed to load campaigns");
      return json.data;
    },
    refetchInterval: (query) => {
      const rows = (query.state.data?.data ?? []) as CampaignRow[];
      // 'running' is the AI dialer's in-flight state; 'pushing' is NeoDove's.
      const hasActive = rows.some(
        (r) => r.status === "running" || r.status === "pushing",
      );
      return hasActive ? 4000 : false;
    },
  });

  const rows = (data?.data ?? []) as CampaignRow[];

  if (isLoading) {
    return (
      <p className="text-sm text-gray-500">Loading campaign history…</p>
    );
  }

  if (isError) {
    return (
      <p className="text-sm text-rose-600">
        Failed to load campaigns. Check the server log for the relation named in
        the error and apply the migration that creates it — naming one migration
        here sent people to the wrong file when a different table was missing.
      </p>
    );
  }

  if (!rows.length) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center">
        <p className="text-sm text-gray-500">No campaigns yet</p>
        <p className="text-xs text-gray-400 mt-1">
          Start the AI dialer for a region to record your first campaign here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-hidden border border-gray-200 rounded-xl bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wider">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">Campaign</th>
              <th className="px-4 py-3 text-left font-semibold">Status</th>
              <th className="px-4 py-3 text-left font-semibold">Provider</th>
              <th className="px-4 py-3 text-left font-semibold">Segment</th>
              <th className="px-4 py-3 text-left font-semibold">Progress</th>
              <th className="px-4 py-3 text-left font-semibold">Started by</th>
              <th className="px-4 py-3 text-left font-semibold">Started</th>
              <th className="px-4 py-3 text-left font-semibold">Duration</th>
              <th className="px-4 py-3 text-right" aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const isNeodove = c.kind === "neodove";
              // NeoDove campaigns have no transcripts, no per-call cost and no
              // dialer queue, so they get their own detail view rather than a
              // half-empty version of the AI-dialer one.
              const href = isNeodove
                ? `/leads/neodove-campaigns/${c.id}`
                : `${basePath}/${c.id}`;
              const startedLabel = c.startedAt
                ? new Date(c.startedAt).toLocaleString("en-IN", {
                    day: "2-digit",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "—";
              const pct =
                c.totalLeads > 0
                  ? Math.round((c.callsMade / c.totalLeads) * 100)
                  : 0;
              return (
                <tr
                  key={c.id}
                  className="border-t border-gray-100 transition-colors hover:bg-gray-50 cursor-pointer group"
                  onClick={() => router.push(href)}
                  // Prefetch only for AI-dialer rows — those query keys point
                  // at /api/ai-dialer/*, which knows nothing about a NeoDove id
                  // and would 404 on hover.
                  onMouseEnter={() => !isNeodove && prefetchCampaign(c.id)}
                  onFocus={() => !isNeodove && prefetchCampaign(c.id)}
                >
                  <td className="px-4 py-3">
                    <Link
                      href={href}
                      onClick={(e) => e.stopPropagation()}
                      className="font-medium text-gray-900 hover:text-emerald-700 hover:underline"
                    >
                      {/* NeoDove campaigns are named by a human at creation;
                          AI-dialer ones are derived from their region filter. */}
                      {isNeodove
                        ? c.name
                        : displayCampaignName({
                            category: c.category,
                            regionFilter: c.regionFilter,
                            startedAt: c.startedAt,
                          })}
                    </Link>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {isNeodove
                        ? (c.category ?? "NeoDove campaign")
                        : summarizeRegion(c.regionFilter)}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <CampaignStatusBadge status={c.status} />
                  </td>
                  <td className="px-4 py-3">{providerChip(c.provider)}</td>
                  <td className="px-4 py-3 text-gray-700">
                    {categoryLabel(c.category)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1.5 min-w-[140px]">
                      <div className="flex items-baseline gap-2 text-[12px]">
                        <span className="font-semibold text-gray-900 tabular-nums">
                          {c.callsMade}
                        </span>
                        <span className="text-gray-400">/</span>
                        <span className="text-gray-600 tabular-nums">
                          {c.totalLeads}
                        </span>
                        <span className="ml-auto text-emerald-700 tabular-nums">
                          {c.completedLeads}
                        </span>
                        {c.failedLeads > 0 && (
                          <span className="text-rose-600 tabular-nums">
                            · {c.failedLeads} failed
                          </span>
                        )}
                      </div>
                      <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            c.status === "running" || c.status === "pushing"
                              ? "bg-amber-400"
                              : c.status === "completed" || c.status === "active"
                                ? "bg-emerald-500"
                                : c.status === "stopped" ||
                                    c.status === "paused" ||
                                    c.status === "draft"
                                  ? "bg-zinc-400"
                                  : "bg-rose-500"
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {c.triggeredByName ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {startedLabel}
                  </td>
                  <td className="px-4 py-3 text-gray-700 text-xs tabular-nums">
                    {fmtTalkTime(c.totalTalkTimeSeconds)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400 group-hover:text-emerald-600">
                    <ChevronRight className="w-4 h-4 inline-block" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between items-center">
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
          disabled={rows.length < 10}
          className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm disabled:opacity-50 hover:bg-gray-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
