"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { fmtDate, liFetch } from "./api";
import { LI_BASE } from "./LinkedInTabs";

type Row = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  counts: Record<string, number>;
};

const STATUS_TONE: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  running: "bg-green-50 text-green-700",
  paused: "bg-amber-50 text-amber-700",
  stopped: "bg-gray-100 text-gray-500",
  done: "bg-blue-50 text-blue-700",
};

export function CampaignsListView() {
  const list = useQuery({ queryKey: ["li-campaigns"], queryFn: () => liFetch<Row[]>("/api/linkedin/campaigns"), refetchInterval: 30_000 });
  const rows = list.data ?? [];
  const n = (r: Row, ...k: string[]) => k.reduce((s, x) => s + (r.counts[x] ?? 0), 0);
  return (
    <div className="space-y-3">
      <div className="flex justify-between">
        <p className="text-sm text-gray-600">Start a campaign from the Search or Prospects tab by selecting people.</p>
        <Link href={`${LI_BASE}/prospects`} className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white">
          Pick prospects
        </Link>
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Campaign</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Prospects</th>
              <th className="px-3 py-2 text-right">Queued</th>
              <th className="px-3 py-2 text-right">Invited</th>
              <th className="px-3 py-2 text-right">Sent</th>
              <th className="px-3 py-2 text-right">Replied</th>
              <th className="px-3 py-2 text-right">Failed</th>
              <th className="px-3 py-2">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-3 py-2">
                  <Link
                    href={r.status === "draft" ? `${LI_BASE}/campaigns/new?campaign=${r.id}` : `${LI_BASE}/campaigns/${r.id}`}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    {r.name}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[r.status] ?? ""}`}>{r.status}</span>
                </td>
                <td className="px-3 py-2 text-right">{Object.values(r.counts).reduce((a, b) => a + b, 0)}</td>
                <td className="px-3 py-2 text-right">{n(r, "approved", "queued")}</td>
                <td className="px-3 py-2 text-right">{n(r, "invite_sent", "accepted")}</td>
                <td className="px-3 py-2 text-right">{n(r, "message_sent", "seen")}</td>
                <td className="px-3 py-2 text-right">{n(r, "replied")}</td>
                <td className="px-3 py-2 text-right">{n(r, "failed")}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{fmtDate(r.created_at)}</td>
              </tr>
            ))}
            {list.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-gray-500">
                  No campaigns yet.
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-red-600">
                  {(list.error as Error).message}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
