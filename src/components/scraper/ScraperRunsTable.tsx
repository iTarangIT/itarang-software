"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

interface ScraperRunsTableProps {
  onSelectRun?: (runId: string) => void;
}

export function ScraperRunsTable({ onSelectRun }: ScraperRunsTableProps) {
  const [page, setPage] = useState(1);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["scraper-runs", page],
    queryFn: async () => {
      const res = await fetch(`/api/scraper/run?page=${page}`);
      const json = await res.json();
      if (!json.success) throw new Error("Failed");
      return json.data;
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
              <th className="p-3 text-left w-[30%]">Run ID</th>
              <th className="p-3 text-left w-[15%]">Status</th>
              <th className="p-3 text-left w-[10%]">Total</th>
              <th className="p-3 text-left w-[10%]">Saved</th>
              <th className="p-3 text-left w-[35%]">Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run: any) => (
              <tr
                key={run.id}
                onClick={() => onSelectRun?.(run.id)}
                className={`border-t transition-colors ${
                  onSelectRun
                    ? "hover:bg-teal-50 cursor-pointer"
                    : "hover:bg-gray-50"
                }`}
              >
                <td className="p-3 truncate font-medium text-gray-800">
                  {run.id}
                </td>
                <td className="p-3">
                  <span
                    className={`px-2 py-1 rounded-full text-xs font-medium ${
                      run.status === "completed"
                        ? "bg-green-100 text-green-700"
                        : run.status === "failed"
                          ? "bg-red-100 text-red-700"
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
              </tr>
            ))}
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
