"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  XCircle,
  Loader2,
  Users,
  Target,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrapedLeadsTable } from "./ScrapedLeadsTable";
import { RawLeadsTable } from "./RawLeadsTable";
import { RunStatusBadge } from "./ExplorationStatusBadge";
import { useState } from "react";

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

interface RunDetail {
  run: {
    id: string;
    status: string;
    started_at: string;
    completed_at: string | null;
    total_found: number;
    new_leads_saved: number;
    duplicates_skipped: number;
    error_message: string | null;
    triggered_by_name: string | null;
    // `search_queries` is stored as jsonb so the runtime shape varies:
    // - markRunStarted (runStore.ts:14) writes a plain string
    // - dealer-scraper-service.ts:114 writes an array of strings
    // - older rows may be null or even a wrapped object
    // We normalize to string[] in `normalizeQueries` before rendering.
    search_queries: unknown;
  };
  leads: unknown[];
  dedup_logs: Array<{
    id: string;
    raw_dealer_name: string | null;
    raw_phone: string | null;
    raw_location: string | null;
    raw_source_url: string | null;
    skip_reason: string;
    created_at: string;
  }>;
}

function normalizeQueries(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  if (typeof raw === "string") {
    // Some old rows stored an array as a JSON-encoded string; try to parse.
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        );
      }
    } catch {
      // not JSON — fall through and treat as a single query string
    }
    return raw ? [raw] : [];
  }
  if (typeof raw === "object" && raw !== null) {
    // Defensive: a `{ queries: [...] }` shape would otherwise be unrendered.
    const inner = (raw as any).queries;
    if (Array.isArray(inner)) {
      return inner.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      );
    }
  }
  return [];
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
      <div
        className={`w-8 h-8 rounded-lg flex items-center justify-center mb-3 ${color}`}
      >
        <Icon className="w-4 h-4" />
      </div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      <p className="text-xs text-gray-500 mt-0.5">{label}</p>
    </div>
  );
}

interface RunDetailViewProps {
  runId: string;
  onBack: () => void;
}

export function RunDetailView({ runId, onBack }: RunDetailViewProps) {
  const [activeTab, setActiveTab] = useState<"saved" | "total">("saved");

  const { data, isLoading, error } = useQuery<RunDetail>({
    queryKey: ["scraper-run-detail", runId],
    queryFn: async () => {
      const res = await fetch(`/api/scraper/runs/${runId}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message);
      return json.data;
    },
    refetchInterval: (query) => {
      const d = query.state.data as RunDetail | undefined;
      return d?.run.status === "running" ? 4000 : false;
    },
  });

  if (isLoading) {
    // Match the live layout so the page doesn't jump on data arrival:
    // back+header line, stats trio, optional queries strip, tabs, table.
    return (
      <div className="space-y-6">
        <div className="flex items-start gap-4">
          <div className="h-8 w-20 bg-gray-100 animate-pulse rounded-lg" />
          <div className="space-y-2">
            <div className="h-6 w-72 bg-gray-100 animate-pulse rounded-lg" />
            <div className="h-4 w-48 bg-gray-100 animate-pulse rounded-lg" />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 bg-gray-100 animate-pulse rounded-xl"
            />
          ))}
        </div>
        <div className="h-10 w-56 bg-gray-100 animate-pulse rounded-lg" />
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-12 bg-gray-100 animate-pulse rounded-xl"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <p className="text-sm text-red-500 bg-red-50 p-4 rounded-xl">
        Failed to load run details.
      </p>
    );
  }

  const { run } = data;
  const queries = normalizeQueries(run.search_queries);

  return (
    <div className="space-y-6">
      {/* Back + Header */}
      <div className="flex items-start gap-4">
        <Button variant="outline" size="sm" onClick={onBack} className="mt-0.5">
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back
        </Button>
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-lg font-bold text-gray-900 font-mono">
              {run.id}
            </h1>
            <RunStatusBadge status={run.status} />
            {run.status === "running" && (
              <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
            )}
          </div>
          <p className="text-sm text-gray-500">
            Triggered by {run.triggered_by_name ?? "Unknown"} ·{" "}
            {fmtDate(run.started_at)}
            {run.completed_at && (
              <>
                {" "}
                →{" "}
                {new Date(run.completed_at).toLocaleTimeString("en-IN", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </>
            )}
          </p>
        </div>
      </div>

      {/* Error banner */}
      {run.error_message && (
        <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-100 rounded-xl text-sm text-red-700">
          <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{run.error_message}</span>
        </div>
      )}

      {/* Stats — duplicate count still appears in the tab label below */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard
          icon={Target}
          label="Total Found"
          value={run.total_found ?? 0}
          color="bg-gray-100 text-gray-600"
        />
        <StatCard
          icon={Users}
          label="New Leads Saved"
          value={run.new_leads_saved ?? 0}
          color="bg-green-100 text-green-600"
        />
      </div>

      {/* Search queries used */}
      {queries.length > 0 && (
        <div className="bg-gray-50 border border-gray-100 rounded-xl p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Queries Used
          </p>
          <ul className="space-y-1">
            {queries.map((q, i) => (
              <li
                key={i}
                className="text-sm text-gray-600 flex items-start gap-2"
              >
                <span className="text-teal-500 mt-0.5">›</span>
                {q}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tabs — "Saved" mirrors the New Leads Saved stat,
                  "Total" mirrors Total Found (i.e., every raw lead the
                  scraper produced, including the ones that got de-duped). */}
      <div>
        <div className="flex items-center justify-between border-b border-gray-100 mb-4">
          <div className="flex gap-1">
            {(["saved", "total"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  activeTab === t
                    ? "border-teal-600 text-teal-700"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                {t === "saved"
                  ? `Saved (${run.new_leads_saved ?? 0})`
                  : `Total (${run.total_found ?? 0})`}
              </button>
            ))}
          </div>
          {(run.total_found ?? 0) > 0 && (
            <a
              href={`/api/scraper/runs/${runId}/export.xlsx`}
              // Plain anchor — the route sets Content-Disposition so the
              // browser downloads the .xlsx file. Two sheets: "Total"
              // (every raw lead, with was_saved flag) and "Saved" (the
              // de-duped rows with the full upstream address).
              className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-teal-700 px-3 py-1.5 border border-gray-200 rounded-lg hover:border-teal-300 mb-2"
              download
            >
              <Download className="w-3.5 h-3.5" />
              Export Excel
            </a>
          )}
        </div>

        {activeTab === "saved" && <ScrapedLeadsTable runId={runId} />}
        {activeTab === "total" && <RawLeadsTable runId={runId} />}
      </div>
    </div>
  );
}
