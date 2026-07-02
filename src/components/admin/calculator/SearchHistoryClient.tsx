"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search, ShieldCheck, Star } from "lucide-react";
import type { SearchHistoryEntry } from "@/lib/calculator/admin-service";

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

const outcomeBadge: Record<string, string> = {
  qualified: "bg-emerald-50 text-emerald-700",
  stretch_only: "bg-amber-50 text-amber-700",
  none: "bg-red-50 text-red-700",
};

const waBadge: Record<string, string> = {
  sent: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
  skipped: "bg-gray-100 text-gray-500",
};

export function SearchHistoryClient({ entries }: { entries: SearchHistoryEntry[] }) {
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<string>("all");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (outcome !== "all" && e.outcome !== outcome) return false;
      if (verifiedOnly && !e.otpVerifiedAt) return false;
      if (!q) return true;
      return (
        e.customerName.toLowerCase().includes(q) ||
        e.phone.toLowerCase().includes(q) ||
        (e.dealerName ?? "").toLowerCase().includes(q) ||
        (e.dealerCode ?? "").toLowerCase().includes(q) ||
        (e.city ?? "").toLowerCase().includes(q)
      );
    });
  }, [entries, query, outcome, verifiedOnly]);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-5 py-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search customer, phone, dealer, city…"
            className="w-full rounded-lg border border-gray-200 bg-gray-50 py-1.5 pl-8 pr-3 text-sm outline-none transition focus:border-gray-400 focus:bg-white"
          />
        </div>
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-sm outline-none"
        >
          <option value="all">All outcomes</option>
          <option value="qualified">Qualified</option>
          <option value="stretch_only">Stretch only</option>
          <option value="none">None</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600">
          <input
            type="checkbox"
            checked={verifiedOnly}
            onChange={(e) => setVerifiedOnly(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-gray-300"
          />
          OTP-verified only
        </label>
        <span className="ml-auto text-xs text-gray-400">
          {filtered.length} of {entries.length} searches
        </span>
      </div>

      {filtered.length === 0 && (
        <p className="px-5 py-6 text-sm text-gray-400">No searches match the current filters.</p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-400">
              <th className="px-5 py-2 font-medium">When</th>
              <th className="px-5 py-2 font-medium">Customer</th>
              <th className="px-5 py-2 font-medium">Dealer</th>
              <th className="px-5 py-2 font-medium">Model / Tenure</th>
              <th className="px-5 py-2 font-medium">Filters</th>
              <th className="px-5 py-2 font-medium">Outcome</th>
              <th className="px-5 py-2 font-medium">Verified</th>
              <th className="px-5 py-2 font-medium">WhatsApp</th>
              <th className="px-5 py-2" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => {
              const isOpen = open === e.id;
              const schemes = [
                ...e.qualified.map((s) => ({ ...s, tier: "Qualified" })),
                ...e.stretch.map((s) => ({ ...s, tier: "Stretch" })),
              ];
              return (
                <Fragment key={e.id}>
                  <tr
                    className="cursor-pointer border-t border-gray-50 hover:bg-gray-50/60"
                    onClick={() => setOpen(isOpen ? null : e.id)}
                  >
                    <td className="whitespace-nowrap px-5 py-3 text-gray-600">
                      {new Date(e.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                    </td>
                    <td className="px-5 py-3">
                      <p className="font-semibold text-gray-900">{e.customerName}</p>
                      <p className="text-xs text-gray-500">
                        {e.phone}
                        {e.city ? ` · ${e.city}` : ""}
                      </p>
                    </td>
                    <td className="px-5 py-3 text-gray-600">
                      {e.dealerName ?? e.dealerCode ?? "—"}
                      {e.dealerName && e.dealerCode && (
                        <span className="ml-1 text-xs text-gray-400">({e.dealerCode})</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-gray-600">
                      {e.modelName ?? "—"}
                      {e.tenureMonths ? ` · ${e.tenureMonths}m` : ""}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-xs text-gray-500">
                      {e.expectedEmi != null ? `EMI ≤ ${inr(e.expectedEmi)}` : "—"}
                      <br />
                      {e.upfrontAbility != null ? `Upfront ≤ ${inr(e.upfrontAbility)}` : ""}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${outcomeBadge[e.outcome ?? ""] ?? "bg-gray-100 text-gray-500"}`}
                      >
                        {e.outcome ?? "—"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3">
                      {e.otpVerifiedAt ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                          <ShieldCheck className="h-3 w-3" />
                          {new Date(e.otpVerifiedAt).toLocaleTimeString("en-IN", { timeStyle: "short" })}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {e.waResultsStatus ? (
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${waBadge[e.waResultsStatus] ?? "bg-gray-100 text-gray-500"}`}
                        >
                          {e.waResultsStatus}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-gray-400">
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-t border-gray-50 bg-gray-50/40">
                      <td colSpan={9} className="px-5 py-4">
                        {schemes.length === 0 ? (
                          <p className="text-xs text-gray-400">No schemes in this result.</p>
                        ) : (
                          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                            {schemes.map((s, i) => (
                              <div
                                key={`${s.nbfc}-${s.schemeCode}-${i}`}
                                className="rounded-xl border border-gray-200 bg-white px-3 py-2.5"
                              >
                                <p className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                                  {s.recommended && <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />}
                                  {s.nbfc}
                                  <span className="font-normal text-gray-400">· {s.schemeCode}</span>
                                  <span
                                    className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                                      s.tier === "Qualified"
                                        ? "bg-emerald-50 text-emerald-700"
                                        : "bg-amber-50 text-amber-700"
                                    }`}
                                  >
                                    {s.tier}
                                  </span>
                                </p>
                                <p className="mt-1 text-xs text-gray-600">
                                  EMI {inr(s.emi)}/m × {s.tenure}m · Pay today {inr(s.totalUpfront)} · Total{" "}
                                  {inr(s.estimatedTotalPayable)}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                        <p className="mt-2 text-[11px] text-gray-400">
                          Config v{e.configVersionId ?? "?"}
                          {e.waResultsSentAt
                            ? ` · schemes sent to customer at ${new Date(e.waResultsSentAt).toLocaleString("en-IN")}`
                            : ""}
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
