"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";

interface ScraperRunsTableProps {
  // Where to link each row. Default `/leads/scrape-runs` keeps the user in
  // the leads context; the `/sales-head/scraper` dashboard passes its own
  // base path so back-navigation lands at the role-specific page.
  detailBasePath?: string;
  // Escape hatch: callers that still want the legacy inline-swap behavior
  // can pass onSelectRun and the row will fall back to firing the callback
  // instead of navigating. Default is to navigate.
  onSelectRun?: (runId: string) => void;
}

export function ScraperRunsTable({
  detailBasePath = "/leads/scrape-runs",
  onSelectRun,
}: ScraperRunsTableProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);

  // Warm both the run-detail and the first page of leads so the detail page
  // renders instantly when the user finally clicks. staleTime is 30s so
  // hovering across multiple rows doesn't hammer the API.
  const prefetchRun = (runId: string) => {
    queryClient.prefetchQuery({
      queryKey: ["scraper-run-detail", runId],
      queryFn: async () => {
        const res = await fetch(`/api/scraper/runs/${runId}`);
        const json = await res.json();
        if (!json.success) throw new Error(json.error?.message);
        return json.data;
      },
      staleTime: 30_000,
    });
    // Match ScrapedLeadsTable's default queryKey shape exactly so its
    // initial fetch is served from cache.
    queryClient.prefetchQuery({
      queryKey: ["scraper-leads", runId, "", "", "created_at_desc", 1],
      queryFn: async () => {
        const params = new URLSearchParams({
          limit: "25",
          offset: "0",
          sort: "created_at_desc",
          run_id: runId,
        });
        const res = await fetch(`/api/scraper/leads?${params}`);
        const json = await res.json();
        if (!json.success) throw new Error(json.error?.message);
        return {
          data: json.data ?? [],
          meta: json.meta ?? { total: 0, limit: 25, offset: 0 },
        };
      },
      staleTime: 30_000,
    });
  };

  const { data, isLoading, isError } = useQuery({
    queryKey: ["scraper-runs", page],
    queryFn: async () => {
      const res = await fetch(`/api/scraper/run?page=${page}`);
      const json = await res.json();
      if (!json.success) throw new Error("Failed");
      return json.data;
    },
    refetchInterval: (query) => {
      const runs = query.state.data?.data ?? [];
      const hasActive = runs.some(
        (r: any) => r.status === "running" || r.status === "cancelling",
      );
      return hasActive ? 4000 : false;
    },
  });

  const runs = data?.data || [];

  if (isLoading) {
    return <p className="text-sm text-gray-500">Loading run history...</p>;
  }

  if (isError) {
    return <p className="text-sm text-red-500">Failed to load run history</p>;
  }

  if (!runs.length) {
    return <p className="text-sm text-gray-500">No runs found</p>;
  }

  return (
    <div className="space-y-4">
      <div className="overflow-hidden border rounded-xl">
        <table className="w-full text-sm table-fixed">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="p-3 text-left w-[35%]">Run ID</th>
              <th className="p-3 text-left w-[15%]">Status</th>
              <th className="p-3 text-left w-[10%]">Total</th>
              <th className="p-3 text-left w-[10%]">Saved</th>
              <th className="p-3 text-left w-[25%]">Started</th>
              <th className="p-3 text-right w-[5%]" aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {runs.map((run: any) => {
              const href = `${detailBasePath}/${run.id}`;
              const useCallback = !!onSelectRun;
              // Whole row is clickable so the user can land anywhere on the
              // row to navigate. The <Link> inside the Run ID cell stays for
              // keyboard tab/enter, middle-click new-tab, and screen readers
              // — clicking the link triggers Next.js navigation directly and
              // is harmless if the row handler also fires (same URL).
              const handleRowClick = useCallback
                ? () => onSelectRun?.(run.id)
                : () => router.push(href);
              return (
                <tr
                  key={run.id}
                  className="border-t transition-colors hover:bg-teal-50 cursor-pointer group"
                  onClick={handleRowClick}
                  onMouseEnter={
                    useCallback ? undefined : () => prefetchRun(run.id)
                  }
                  onFocus={
                    useCallback ? undefined : () => prefetchRun(run.id)
                  }
                >
                  <td className="p-3 truncate font-medium text-gray-800">
                    {useCallback ? (
                      <span>{run.id}</span>
                    ) : (
                      <Link
                        href={href}
                        className="text-gray-800 hover:text-teal-700 hover:underline focus:outline-none focus:ring-2 focus:ring-teal-500 rounded"
                        // Stop the row's onClick from double-firing the same
                        // navigation; the Link itself navigates fine on its
                        // own left-click and on middle-click for new-tab.
                        onClick={(e) => e.stopPropagation()}
                      >
                        {run.id}
                      </Link>
                    )}
                  </td>
                  <td className="p-3">
                    <span
                      className={`px-2 py-1 rounded-full text-xs font-medium ${
                        run.status === "completed"
                          ? "bg-green-100 text-green-700"
                          : run.status === "failed"
                            ? "bg-red-100 text-red-700"
                            : run.status === "cancelled"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="p-3">{run.totalFound ?? 0}</td>
                  <td className="p-3">{run.newLeadsSaved ?? 0}</td>
                  <td className="p-3 truncate text-gray-500">
                    {run.startedAt
                      ? new Date(run.startedAt).toLocaleString()
                      : "-"}
                  </td>
                  <td className="p-3 text-right text-gray-400 group-hover:text-teal-600">
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
          className="px-3 py-1 border rounded-lg text-sm disabled:opacity-50 cursor-pointer"
        >
          Previous
        </button>
        <span className="text-sm text-gray-600">Page {page}</span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={runs.length < 10}
          className="px-3 py-1 border rounded-lg text-sm disabled:opacity-50 cursor-pointer"
        >
          Next
        </button>
      </div>
    </div>
  );
}
