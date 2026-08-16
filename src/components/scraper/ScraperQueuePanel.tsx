"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Sparkles,
  XCircle,
} from "lucide-react";
import Link from "next/link";

// E-241 — the Batches tab.
//
// One row per submission with a done/total bar, expandable to the per-job rows.
// The counts are rolled up in SQL (see listBatches) rather than by fetching the
// jobs, because a 500-job batch is 500 rows this view has no use for and this
// endpoint is polled while work drains.

interface BatchSummary {
  batch_id: string;
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  leads_promoted: number;
  expand_with_ai: boolean;
  schedule_mode: "now" | "once" | "daily";
  run_after: string | null;
  window_start: string | null;
  window_end: string | null;
  window_days: string[] | null;
  created_at: string;
  sample_query: string | null;
}

interface JobRow {
  id: string;
  seq: number;
  query_text: string;
  city: string | null;
  status: string;
  run_id: string | null;
  last_error: string | null;
  leads_promoted: number;
}

const STATUS_STYLES: Record<string, string> = {
  queued: "bg-gray-100 text-gray-600",
  running: "bg-blue-50 text-blue-700",
  done: "bg-green-50 text-green-700",
  failed: "bg-red-50 text-red-700",
  cancelled: "bg-amber-50 text-amber-700",
};

function scheduleLabel(b: BatchSummary): string {
  if (b.schedule_mode === "once" && b.run_after) {
    return `Once at ${new Date(b.run_after).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "short",
    })} IST`;
  }
  if (b.schedule_mode === "daily") {
    const days = b.window_days?.length
      ? b.window_days.map((d) => d[0].toUpperCase() + d.slice(1)).join(", ")
      : "every day";
    return `Daily ${b.window_start}–${b.window_end} IST · ${days}`;
  }
  return "Run now";
}

export function ScraperQueuePanel({
  detailBasePath = "/leads/scrape-runs",
}: {
  detailBasePath?: string;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["scraper-batches"],
    queryFn: async () => {
      const res = await fetch("/api/scraper/batch");
      const json = await res.json();
      if (!json.success) {
        throw new Error(json.error?.message || "Failed to load batches");
      }
      return json.data as { batches: BatchSummary[]; outstanding: number };
    },
    // Poll while anything is outstanding. Mirrors ScraperRunProgress: the queue
    // is driven by a 30s server-side ticker, so a 10s poll is more than enough
    // to make dispatch look immediate without hammering the endpoint.
    refetchInterval: (q) =>
      (q.state.data as { outstanding?: number } | undefined)?.outstanding
        ? 10_000
        : false,
  });

  const { data: jobs, isLoading: jobsLoading } = useQuery({
    queryKey: ["scraper-batch", expanded],
    enabled: !!expanded,
    queryFn: async () => {
      const res = await fetch(`/api/scraper/batch/${expanded}`);
      const json = await res.json();
      if (!json.success) {
        throw new Error(json.error?.message || "Failed to load jobs");
      }
      return json.data.jobs as JobRow[];
    },
    refetchInterval: 10_000,
  });

  const cancel = useMutation({
    mutationFn: async (batchId: string) => {
      const res = await fetch(`/api/scraper/batch/${batchId}/cancel`, {
        method: "POST",
      });
      const json = await res.json();
      if (!json.success) {
        throw new Error(json.error?.message || "Cancel failed");
      }
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scraper-batches"] });
      queryClient.invalidateQueries({ queryKey: ["scraper-batch"] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-8 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading batches…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 p-4 rounded-xl bg-red-50 border border-red-100 text-sm text-red-800">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>{(error as Error).message}</span>
      </div>
    );
  }

  const batches = data?.batches ?? [];

  if (!batches.length) {
    return (
      <p className="text-sm text-gray-500 py-8 text-center">
        No batches yet. Switch the form above to <strong>Batch</strong> to queue
        several searches at once.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {(data?.outstanding ?? 0) > 0 && (
        <p className="text-xs text-gray-500 inline-flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" />
          {data!.outstanding} job{data!.outstanding === 1 ? "" : "s"} outstanding
          — they run one at a time.
        </p>
      )}

      {batches.map((b) => {
        const finished = b.done + b.failed + b.cancelled;
        const pct = b.total ? Math.round((finished / b.total) * 100) : 0;
        const isOpen = expanded === b.batch_id;
        const hasQueued = b.queued > 0;

        return (
          <div
            key={b.batch_id}
            className="border border-gray-200 rounded-xl overflow-hidden bg-white"
          >
            <div className="flex items-start gap-3 p-3">
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : b.batch_id)}
                className="mt-0.5 text-gray-400 hover:text-gray-700"
                aria-label={isOpen ? "Collapse batch" : "Expand batch"}
              >
                {isOpen ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </button>

              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 truncate">
                    {b.sample_query || b.batch_id}
                    {b.total > 1 && (
                      <span className="text-gray-400 font-normal">
                        {" "}
                        +{b.total - 1} more
                      </span>
                    )}
                  </span>
                  {b.expand_with_ai && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-amber-50 text-amber-700 border border-amber-100">
                      <Sparkles className="w-3 h-3" />
                      AI
                    </span>
                  )}
                  {b.running > 0 && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-blue-50 text-blue-700">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      running
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 mt-2">
                  <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-teal-500 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-500 tabular-nums shrink-0">
                    {finished}/{b.total}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px] text-gray-500">
                  <span className="inline-flex items-center gap-1">
                    <CalendarClock className="w-3 h-3" />
                    {scheduleLabel(b)}
                  </span>
                  {b.leads_promoted > 0 && (
                    <span className="text-green-700">
                      {b.leads_promoted} lead
                      {b.leads_promoted === 1 ? "" : "s"} added
                    </span>
                  )}
                  {b.failed > 0 && (
                    <span className="text-red-600">{b.failed} failed</span>
                  )}
                  {b.cancelled > 0 && (
                    <span className="text-amber-700">
                      {b.cancelled} cancelled
                    </span>
                  )}
                  <span>
                    {new Date(b.created_at).toLocaleString("en-IN", {
                      timeZone: "Asia/Kolkata",
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </span>
                </div>
              </div>

              {hasQueued && (
                <button
                  type="button"
                  onClick={() => cancel.mutate(b.batch_id)}
                  disabled={cancel.isPending}
                  className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 hover:text-red-600 disabled:opacity-50"
                  title="Cancels the queued jobs. A job already running finishes."
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Cancel remaining
                </button>
              )}
            </div>

            {isOpen && (
              <div className="border-t border-gray-100 bg-gray-50/50">
                {jobsLoading ? (
                  <p className="px-4 py-3 text-xs text-gray-500">Loading jobs…</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500">
                        <th className="px-4 py-1.5 font-medium w-10">#</th>
                        <th className="px-3 py-1.5 font-medium">Query</th>
                        <th className="px-3 py-1.5 font-medium">City</th>
                        <th className="px-3 py-1.5 font-medium w-24">Status</th>
                        <th className="px-3 py-1.5 font-medium w-16 text-right">
                          Leads
                        </th>
                        <th className="px-4 py-1.5 font-medium w-20">Run</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(jobs ?? []).map((j) => (
                        <tr key={j.id} className="border-t border-gray-100">
                          <td className="px-4 py-1.5 text-gray-400">
                            {j.seq + 1}
                          </td>
                          <td className="px-3 py-1.5 text-gray-800">
                            {j.query_text}
                            {j.last_error && (
                              <span
                                className="block text-[10px] text-red-600 truncate max-w-md"
                                title={j.last_error}
                              >
                                {j.last_error}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-gray-600">
                            {j.city ?? (
                              <span className="text-gray-400">AI-picked</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] ${
                                STATUS_STYLES[j.status] ??
                                "bg-gray-100 text-gray-600"
                              }`}
                            >
                              {j.status}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">
                            {j.leads_promoted || "—"}
                          </td>
                          <td className="px-4 py-1.5">
                            {j.run_id ? (
                              <Link
                                href={`${detailBasePath}/${j.run_id}`}
                                className="text-teal-600 hover:underline"
                              >
                                view
                              </Link>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
