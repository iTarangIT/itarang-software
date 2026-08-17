"use client";

/**
 * E-242 — the complete OEM price history, across every model.
 *
 * WHAT THIS ANSWERS THAT NOTHING ELSE DID
 *   "Which price was applied to which Model ID, and when was it changed?"
 *   OemPriceScheduleDrawer already shows one product's lines, but reading the
 *   register that way means opening products one at a time and holding the
 *   comparison in your head. This is the ledger: every revision ever made,
 *   newest first, with what it replaced.
 *
 * NOTHING NEW IS STORED. oem_reference_prices has been append-only since E-226
 * — a revision closes the row it replaces and inserts a new one, and the old
 * number stays on disk. The previous price is read with LAG() in the query
 * rather than duplicated into a column that could later disagree with the row
 * above it.
 *
 * A section on /oem-pricing rather than a page of its own, deliberately: a
 * second door to one register is the exact complaint the same call raised about
 * the leads screens.
 */

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, History, Minus } from "lucide-react";

interface HistoryRow {
  price_id: string;
  asset_type: string;
  product_id: string;
  model_id: string | null;
  product_name: string | null;
  oem_price: number;
  previous_price: number | null;
  delta: number | null;
  delta_pct: number | null;
  effective_from: string;
  effective_to: string | null;
  valid_until: string | null;
  note: string | null;
  created_by_name: string | null;
  created_at: string;
}

interface HistoryResponse {
  revisions: HistoryRow[];
  total: number;
  limit: number;
  offset: number;
}

const ASSET_LABEL: Record<string, string> = {
  battery: "Battery",
  charger: "Charger",
  paraphernalia: "Paraphernalia",
};

const PAGE_SIZE = 25;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function money(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/**
 * What this line did to the price.
 *
 * A first line is "First price", NOT a zero change — the two mean different
 * things and a 0 with a flat arrow would read as "somebody re-entered the same
 * number".
 */
function Change({ row }: { row: HistoryRow }) {
  if (row.previous_price == null) {
    return <span className="text-[11px] text-gray-400">First price</span>;
  }
  if (!row.delta) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-gray-500">
        <Minus className="h-3 w-3" /> No change
      </span>
    );
  }
  const up = row.delta > 0;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-medium tabular-nums ${
        up ? "text-rose-600" : "text-emerald-600"
      }`}
    >
      {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {up ? "+" : "−"}
      {Math.abs(row.delta).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
      {row.delta_pct != null && (
        <span className="opacity-70">
          ({up ? "+" : ""}
          {row.delta_pct}%)
        </span>
      )}
    </span>
  );
}

/** A line is in force when it is open and its declared window has not passed. */
function statusOf(row: HistoryRow, now: number): { label: string; cls: string } {
  if (row.effective_to) {
    return { label: "Superseded", cls: "bg-gray-100 text-gray-600" };
  }
  if (new Date(row.effective_from).getTime() > now) {
    return { label: "Scheduled", cls: "bg-blue-100 text-blue-700" };
  }
  if (row.valid_until && new Date(row.valid_until).getTime() <= now) {
    // Expired without a successor: the product silently stopped auto-approving.
    return { label: "Expired", cls: "bg-amber-100 text-amber-800" };
  }
  return { label: "In force", cls: "bg-emerald-100 text-emerald-700" };
}

export function OemPriceHistory() {
  const [assetFilter, setAssetFilter] = React.useState<string>("all");
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [now] = React.useState(() => Date.now());

  React.useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isError } = useQuery<HistoryResponse>({
    queryKey: ["oem-price-history", assetFilter, debounced, page],
    queryFn: async () => {
      const p = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (assetFilter !== "all") p.set("assetType", assetFilter);
      if (debounced.trim()) p.set("search", debounced.trim());
      const r = await fetch(`/api/dashboard/ceo/oem-prices/history?${p}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error("Failed to load the price history");
      return (await r.json()).data as HistoryResponse;
    },
  });

  const rows = data?.revisions ?? [];
  const total = data?.total ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <section className="rounded-xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-gray-400" />
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Price history</h2>
            <p className="text-[11px] text-gray-500">
              Every price ever set, per Model ID, with what it replaced. Nothing here is
              overwritten — a revision adds a line.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search model or product…"
            className="w-52 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs outline-none focus:border-blue-500"
          />
          <div className="flex rounded-lg border border-gray-200 p-0.5">
            {["all", "battery", "charger", "paraphernalia"].map((a) => (
              <button
                key={a}
                onClick={() => {
                  setAssetFilter(a);
                  setPage(0);
                }}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                  assetFilter === a
                    ? "bg-gray-900 text-white"
                    : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                {a === "all" ? "All" : ASSET_LABEL[a]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[11px] tabular-nums">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50/60 text-left text-[10px] uppercase tracking-wide text-gray-500">
              <th className="px-3 py-2 font-semibold">Model ID</th>
              <th className="px-3 py-2 font-semibold">Product</th>
              <th className="px-3 py-2 font-semibold">Type</th>
              <th className="px-3 py-2 text-right font-semibold">Previous</th>
              <th className="px-3 py-2 text-right font-semibold">Price</th>
              <th className="px-3 py-2 font-semibold">Change</th>
              <th className="px-3 py-2 font-semibold">Effective from</th>
              <th className="px-3 py-2 font-semibold">Valid until</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Set by</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-gray-400">
                  Loading price history…
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-rose-600">
                  Couldn&apos;t load the price history.
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-gray-400">
                  No price lines yet. Set a price above and it will appear here.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const st = statusOf(r, now);
                return (
                  <tr key={r.price_id} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-3 py-2 font-mono text-[10px] font-semibold text-gray-900">
                      {r.model_id ?? "—"}
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2 text-gray-700">
                      {r.product_name ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-gray-500">
                      {ASSET_LABEL[r.asset_type] ?? r.asset_type}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-500">
                      {money(r.previous_price)}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-gray-900">
                      {money(r.oem_price)}
                    </td>
                    <td className="px-3 py-2">
                      <Change row={r} />
                    </td>
                    <td className="px-3 py-2 text-gray-600">{fmtDate(r.effective_from)}</td>
                    <td className="px-3 py-2 text-gray-600">{fmtDate(r.valid_until)}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${st.cls}`}
                      >
                        {st.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-500" title={r.note ?? undefined}>
                      {r.created_by_name ?? "—"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2.5 text-[11px] text-gray-500">
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded border border-gray-200 px-2 py-1 font-medium hover:bg-gray-50 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
              disabled={page >= lastPage}
              className="rounded border border-gray-200 px-2 py-1 font-medium hover:bg-gray-50 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
