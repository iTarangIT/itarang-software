"use client";

/**
 * M06 — the admin review queue.
 *
 * Columns per the design handoff: Request · Dealer · Provenance · Dealer quote ·
 * SLA aging · Status.
 *
 * The provenance bar reflects ALL lines on the request. The prototype computed it
 * from `d.lines[0]` alone, so a two-SKU request whose second battery had no
 * paperwork at all still showed 100% and sailed into review.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import StatusChip from "@/components/buyback/StatusChip";
import { inr } from "@/lib/buyback/format";

interface QueueRow {
  request_id: string;
  request_no: string;
  source_channel: string;
  status: string;
  dealer_name: string;
  dealer_city: string | null;
  total_units: number;
  dealer_quote: number;
  provenance_pct: number;
  days_in_queue: number;
  hours_in_queue: number;
}

export default function AdminBuybackQueuePage() {
  const router = useRouter();
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/buyback/queue")
      .then((r) => r.json())
      .then((j) => setQueue(j?.data?.queue ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">Review Queue</h1>
        <p className="mt-1 text-sm text-slate-500">
          Buyback requests awaiting review &amp; negotiation.
        </p>
      </header>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3 text-left">Request</th>
              <th className="px-4 py-3 text-left">Dealer</th>
              <th className="px-4 py-3 text-left">Provenance</th>
              <th className="px-4 py-3 text-right">Dealer quote</th>
              <th className="px-4 py-3 text-left">SLA aging</th>
              <th className="px-4 py-3 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            )}

            {!loading && queue.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center">
                  <div className="text-3xl">✅</div>
                  <p className="mt-2 font-semibold text-slate-700">The queue is empty</p>
                  <p className="text-sm text-slate-500">Nothing is waiting on iTarang.</p>
                </td>
              </tr>
            )}

            {queue.map((r) => (
              <tr
                key={r.request_id}
                className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                tabIndex={0}
                onClick={() => router.push(`/admin/buyback/${r.request_id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") router.push(`/admin/buyback/${r.request_id}`);
                }}
              >
                <td className="px-4 py-3">
                  <Link
                    href={`/admin/buyback/${r.request_id}`}
                    className="font-semibold text-slate-900 hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {r.request_no}
                  </Link>
                  <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                    {r.source_channel === "WHATSAPP" ? "WhatsApp" : "Portal"}
                  </span>
                </td>

                <td className="px-4 py-3">
                  <div className="font-semibold text-slate-800">{r.dealer_name}</div>
                  <div className="text-[11.5px] text-slate-400">{r.dealer_city ?? "—"}</div>
                </td>

                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-12 overflow-hidden rounded bg-slate-100">
                      <div
                        className={`h-full ${
                          r.provenance_pct >= 80
                            ? "bg-emerald-500"
                            : r.provenance_pct >= 50
                              ? "bg-amber-500"
                              : "bg-red-500"
                        }`}
                        style={{ width: `${r.provenance_pct}%` }}
                      />
                    </div>
                    <span className="text-xs tabular-nums text-slate-500">
                      {r.provenance_pct}%
                    </span>
                  </div>
                </td>

                <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-900">
                  {inr(r.dealer_quote)}
                </td>

                <td className="px-4 py-3">
                  <span className="rounded-md bg-amber-100 px-2 py-1 text-[11.5px] font-bold text-amber-700">
                    {r.days_in_queue >= 1
                      ? `${r.days_in_queue}d in queue`
                      : `${r.hours_in_queue}h in queue`}
                  </span>
                </td>

                <td className="px-4 py-3">
                  <StatusChip status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
