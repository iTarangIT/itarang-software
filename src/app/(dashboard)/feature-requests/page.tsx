"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Lightbulb, Loader2, Plus } from "lucide-react";

import { api, formatDateTime, type ListItem } from "@/components/feature-requests/api";
import { PriorityBadge, StatusBadge } from "@/components/feature-requests/badges";
import { cn } from "@/lib/utils";
import type { Seat } from "@/lib/feature-requests/workflow";

const VIEWS = [
  { id: "awaiting_me", label: "Awaiting me" },
  { id: "active", label: "In progress" },
  { id: "done", label: "Closed / Rejected" },
  { id: "all", label: "All" },
] as const;

type View = (typeof VIEWS)[number]["id"];

export default function FeatureRequestsPage() {
  const router = useRouter();
  const [view, setView] = useState<View>("awaiting_me");

  const { data, isLoading, error } = useQuery({
    queryKey: ["feature-requests", view],
    queryFn: () => api<{ seat: Seat; items: ListItem[] }>(`/api/feature-requests?view=${view}`),
  });

  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-12">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <Lightbulb className="h-7 w-7 text-amber-500" />
            Feature Requests
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Raise, review, approve and track every feature — with the full discussion in one place.
          </p>
        </div>
        {data?.seat === "requester" && (
          <Link
            href="/feature-requests/new"
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" /> New Feature Request
          </Link>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            className={cn(
              "rounded-lg px-4 py-2 text-xs font-semibold transition-colors",
              view === v.id ? "bg-blue-600 text-white" : "bg-gray-50 text-gray-600 hover:bg-gray-100",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-gray-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="py-16 text-center text-sm text-red-600">{(error as Error).message}</div>
        ) : !data || data.items.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">
            {view === "awaiting_me" ? "Nothing is waiting on you." : "No feature requests here yet."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-3">Request</th>
                  <th className="px-4 py-3">Priority</th>
                  <th className="px-4 py-3">Module</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">With</th>
                  <th className="px-4 py-3">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.items.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => router.push(`/feature-requests/${r.id}`)}
                    className="cursor-pointer hover:bg-blue-50/40"
                  >
                    <td className="px-4 py-3">
                      <Link href={`/feature-requests/${r.id}`} className="block" onClick={(e) => e.stopPropagation()}>
                        <span className="font-mono text-xs text-gray-400">{r.code}</span>
                        {r.revision > 1 && <span className="ml-1 text-[10px] text-gray-400">rev {r.revision}</span>}
                        <span className="block font-medium text-gray-900">{r.title}</span>
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <PriorityBadge priority={r.priority} />
                    </td>
                    <td className="px-4 py-3 text-gray-600">{r.module}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {r.status === "closed" ? "—" : (r.current_owner_name ?? "—")}
                      {r.assigned_developer_name && r.status !== "closed" && r.current_owner_name !== r.assigned_developer_name && (
                        <span className="block text-xs text-gray-400">Dev: {r.assigned_developer_name}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-gray-500">{formatDateTime(r.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
