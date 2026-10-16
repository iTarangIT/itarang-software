"use client";

// ID 183 Phase 1 — "Pushed files": every customer file the iTarang house
// pushed to a dealer (dealer, stage, last action, age) until disbursed or
// closed. Used on the CRM (/admin/kyc-review/pushed-files — Admin, Sales Head)
// and by the house logins in the dealer portal (/dealer-portal/pushed-files).
// Admin can search by customer mobile across every dealer.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Search } from "lucide-react";

interface Row {
  leadId: string;
  referenceId: string | null;
  customerName: string;
  customerMobile: string | null;
  dealer: { dealerId: string | null; name: string | null; mobile: string | null };
  stage: string;
  pushedAt: string | null;
  pushedBy: string | null;
  lastAction: { label: string; at: string; by: string | null } | null;
  ageDays: number | null;
  housePushed: boolean;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" });
}

export default function PushedFilesList({ hrefFor }: { hrefFor: "crm" | "dealer" }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [canSearchAll, setCanSearchAll] = useState(false);
  const [mobile, setMobile] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (m?: string) => {
    setLoading(true);
    try {
      const q = m ? `?mobile=${encodeURIComponent(m)}` : "";
      const res = await fetch(`/api/leads/pushed-files${q}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || "Could not load pushed files");
      setRows(json.data.files);
      setCanSearchAll(!!json.data.canSearchAllDealers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load pushed files");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const link = (id: string) =>
    hrefFor === "crm" ? `/admin/kyc-review/${encodeURIComponent(id)}` : `/dealer-portal/leads/${encodeURIComponent(id)}`;

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load(mobile.trim());
        }}
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <input
            className="w-64 rounded-lg border border-gray-300 py-2 pl-8 pr-3 text-sm"
            placeholder="Customer mobile"
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
          />
        </div>
        <button type="submit" className="rounded-lg bg-[#0047AB] px-3 py-2 text-sm font-medium text-white">
          Search
        </button>
        {mobile && (
          <button
            type="button"
            className="text-sm text-gray-600"
            onClick={() => {
              setMobile("");
              void load();
            }}
          >
            Clear
          </button>
        )}
        <span className="text-xs text-gray-500">
          {canSearchAll ? "Search finds the customer's file with any dealer." : "Search within the files iTarang pushed."}
        </span>
      </form>

      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {loading && !rows && <p className="text-sm text-gray-500">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">No pushed files open.</p>
      )}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">Dealer</th>
                <th className="px-4 py-2">Stage</th>
                <th className="px-4 py-2">Last action</th>
                <th className="px-4 py-2">Pushed</th>
                <th className="px-4 py-2">Age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.leadId} className="border-t border-gray-100 align-top">
                  <td className="px-4 py-2">
                    <Link href={link(r.leadId)} className="font-medium text-[#0047AB] hover:underline">
                      {r.customerName}
                    </Link>
                    <div className="text-xs text-gray-500">
                      {r.referenceId ?? r.leadId}
                      {r.customerMobile ? ` · ${r.customerMobile}` : ""}
                    </div>
                    {!r.housePushed && <div className="text-xs text-amber-700">Dealer&apos;s own file (not pushed by iTarang)</div>}
                  </td>
                  <td className="px-4 py-2">
                    {r.dealer.name ?? "—"}
                    {r.dealer.mobile && <div className="text-xs text-gray-500">{r.dealer.mobile}</div>}
                  </td>
                  <td className="px-4 py-2">{r.stage}</td>
                  <td className="px-4 py-2">
                    {r.lastAction ? (
                      <>
                        {r.lastAction.label}
                        <div className="text-xs text-gray-500">
                          {fmt(r.lastAction.at)}
                          {r.lastAction.by ? ` · ${r.lastAction.by}` : ""}
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {fmt(r.pushedAt)}
                    {r.pushedBy && <div className="text-xs text-gray-500">by {r.pushedBy}</div>}
                  </td>
                  <td className="px-4 py-2">{r.ageDays === null ? "—" : `${r.ageDays} d`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
