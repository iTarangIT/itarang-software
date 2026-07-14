"use client";

/**
 * M01 — the dealer's buyback dashboard.
 *
 * Entity-scoped by the API: /api/buyback/requests only ever returns rows whose
 * dealer_entity_id matches the caller's. Another dealer's request is not just
 * hidden here — it 404s at the API too.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import StatusChip, { OfferVersionChip } from "@/components/buyback/StatusChip";

interface RequestRow {
  request_id: string;
  request_no: string;
  status: string;
  offer_version: number;
  line_count: number;
  total_units: number;
  created_at: string;
  submitted_at: string | null;
}

const OPEN_STATES = new Set([
  "SUBMITTED",
  "UNDER_REVIEW",
  "INFO_REQUESTED",
  "NEGOTIATING",
  "FINAL_OFFER_SENT",
]);

export default function DealerBuybackPage() {
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/buyback/requests")
      .then((r) => r.json())
      .then((j) => setRequests(j?.data?.requests ?? []))
      .finally(() => setLoading(false));
  }, []);

  const drafts = requests.filter((r) => r.status === "DRAFT").length;
  const open = requests.filter((r) => OPEN_STATES.has(r.status)).length;
  const needsYou = requests.filter(
    (r) => r.status === "INFO_REQUESTED" || r.status === "FINAL_OFFER_SENT",
  ).length;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">
            Battery Buyback
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Sell your end-of-life batteries to iTarang.
          </p>
        </div>
        <Link
          href="/dealer-portal/buyback/new"
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          + New Request
        </Link>
      </header>

      <div className="mb-6 grid grid-cols-3 gap-4">
        <Kpi label="Awaiting your action" value={needsYou} accent={needsYou > 0} />
        <Kpi label="In progress" value={open} />
        <Kpi label="Drafts" value={drafts} />
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3 text-left">Request</th>
              <th className="px-4 py-3 text-left">Batteries</th>
              <th className="px-4 py-3 text-left">Units</th>
              <th className="px-4 py-3 text-left">Raised</th>
              <th className="px-4 py-3 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            )}

            {!loading && requests.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center">
                  <div className="text-3xl">🔋</div>
                  <p className="mt-2 font-semibold text-slate-700">No buyback requests yet</p>
                  <p className="text-sm text-slate-500">
                    Raise one to sell your end-of-life batteries.
                  </p>
                </td>
              </tr>
            )}

            {requests.map((r) => (
              <tr key={r.request_id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link
                    href={`/dealer-portal/buyback/${r.request_id}`}
                    className="font-semibold text-slate-900 hover:underline"
                  >
                    {r.request_no}
                  </Link>
                </td>
                <td className="px-4 py-3 text-slate-600">{r.line_count}</td>
                <td className="px-4 py-3 tabular-nums text-slate-600">{r.total_units}</td>
                <td className="px-4 py-3 text-slate-500">
                  {new Date(r.submitted_at ?? r.created_at).toLocaleDateString("en-IN")}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <StatusChip status={r.status} />
                    <OfferVersionChip version={r.offer_version} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      className={`rounded-xl border bg-white p-4 ${
        accent ? "border-amber-300 bg-amber-50" : "border-slate-200"
      }`}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div
        className={`mt-1 text-2xl font-extrabold tabular-nums ${
          accent ? "text-amber-700" : "text-slate-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
