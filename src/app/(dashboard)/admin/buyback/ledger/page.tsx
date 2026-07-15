"use client";

/**
 * Transaction history — the money ledger (M14), restyled onto the shared
 * buyback UI kit (design handoff, iTarang Portal.dc.html `scrTxnHistory`,
 * lines 1201-1228).
 *
 * The reconciliation banner is the point of this screen, not the table. Its AC:
 *
 *   "ledger net for CLOSED deals == dashboard Total Margin Earned"
 *
 * Those two numbers come from independent places — what MOVED (settlements) and
 * what was AGREED (deal_line_locks, frozen and fill-once). If they ever disagree,
 * a report is lying and someone must know TODAY, not at the next audit. So the
 * banner is shown whether it passes or fails, rather than only surfacing on
 * failure: a silent green check that nobody has seen is indistinguishable from a
 * check that never ran. The reconciliation numbers are always all-time — the
 * route computes them from the full ledger regardless of the row list's window.
 *
 * E-192-B: the route now bounds the ROW LIST (default last 90 days, `?limit=`
 * capped at 5000) rather than returning every settlement ever recorded. Date
 * range moved from a client-side filter to a SERVER param — changing it
 * refetches page 1 rather than re-slicing an already-loaded array — with a
 * "Load more" row underneath when `has_more`. Direction / Method stay
 * client-side filters over whatever page(s) are loaded, unchanged from before.
 */

import { useEffect, useMemo, useState } from "react";

import { Card, DealTable, FilterPill, KpiCard, PageHeader } from "@/components/buyback/ui";
import type { DealTableHead, DealTableRow } from "@/components/buyback/ui";
import { inr } from "@/lib/buyback/format";

interface Row {
  txn: string;
  request_no: string;
  counterparty: string;
  direction: "IN" | "OUT";
  method: string;
  txn_ref: string | null;
  proof_s3: string | null;
  txn_date: string;
  recorded_by: string | null;
  amount: string;
}

interface Reconciliation {
  scope: string;
  ledger_net: number;
  /** Σ qty × (vendor_price − dealer_price) — what the locks say we EARNED. */
  expected_margin: number;
  /** Σ qty × margin_value — what we set out to earn. */
  planned_margin: number;
  /** What the vendor negotiation was worth. */
  uplift: number;
  difference: number;
  reconciled: boolean;
}

const ALL = "ALL";
const FETCH_LIMIT = 1000;
const MAX_CSV_LIMIT = 5000;
// An explicit far-past date, rather than omitting `from`/`to` altogether — the
// route defaults an unqualified request to the last 90 days, so "All time"
// here opts back OUT of that default instead of silently landing on it.
const ALL_TIME_FROM = "2000-01-01";

const DATE_RANGE_OPTIONS = [
  { value: ALL, label: "All time" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days (default)" },
];

const HEADS: DealTableHead[] = [
  { label: "Transaction" },
  { label: "Deal" },
  { label: "Party" },
  { label: "Direction" },
  { label: "Amount", align: "right" },
  { label: "Method" },
  { label: "Date" },
  { label: "By" },
];

/** `?from=` value for the given date-range pill selection. */
function fromParam(dateFilter: string): string {
  if (dateFilter === ALL) return ALL_TIME_FROM;
  const days = Number(dateFilter);
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export default function BuybackLedgerPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [directionFilter, setDirectionFilter] = useState(ALL);
  const [methodFilter, setMethodFilter] = useState(ALL);
  // Server-driven now (was a client-side filter) — defaults to "Last 90 days",
  // matching the route's own default window.
  const [dateFilter, setDateFilter] = useState("90");

  // Fetches page 1 whenever the date-range pill changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRows([]);
    setHasMore(false);

    (async () => {
      try {
        const res = await fetch(
          `/api/admin/buyback/ledger?limit=${FETCH_LIMIT}&from=${fromParam(dateFilter)}`,
        );
        const json = await res.json();
        if (cancelled) return;
        if (json?.success === false) {
          setError(json?.error?.message ?? "Could not load the transaction history.");
          return;
        }
        setRows(json?.data?.rows ?? []);
        setReconciliation(json?.data?.reconciliation ?? null);
        setHasMore(Boolean(json?.data?.has_more));
      } catch {
        if (!cancelled) setError("Could not load the transaction history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dateFilter]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/admin/buyback/ledger?limit=${FETCH_LIMIT}&offset=${rows.length}&from=${fromParam(dateFilter)}`,
      );
      const json = await res.json();
      if (json?.success === false) {
        setError(json?.error?.message ?? "Could not load more transactions.");
        return;
      }
      setRows((prev) => [...prev, ...((json?.data?.rows ?? []) as Row[])]);
      setHasMore(Boolean(json?.data?.has_more));
    } catch {
      setError("Could not load more transactions.");
    } finally {
      setLoadingMore(false);
    }
  };

  const methodOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) seen.add(r.method);
    return [{ value: ALL, label: "All" }, ...[...seen].sort().map((m) => ({ value: m, label: m }))];
  }, [rows]);

  const directionOptions = [
    { value: ALL, label: "All" },
    { value: "IN", label: "IN" },
    { value: "OUT", label: "OUT" },
  ];

  // Direction / Method stay client-side over whichever page(s) are loaded —
  // the date range itself is now applied server-side, above.
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (directionFilter !== ALL && r.direction !== directionFilter) return false;
      if (methodFilter !== ALL && r.method !== methodFilter) return false;
      return true;
    });
  }, [rows, directionFilter, methodFilter]);

  // Total IN/OUT/NET describe the full loaded window (ignoring the
  // Direction/Method pills, same as before this change), recomputed
  // client-side so they stay correct as more pages are loaded in.
  const totals = useMemo(() => {
    const totalIn = rows.filter((r) => r.direction === "IN").reduce((s, r) => s + Number(r.amount), 0);
    const totalOut = rows.filter((r) => r.direction === "OUT").reduce((s, r) => s + Number(r.amount), 0);
    return { in: totalIn, out: totalOut, net: totalIn - totalOut };
  }, [rows]);

  const tableRows: DealTableRow[] = filteredRows.map((r) => ({
    key: r.txn,
    cells: [
      <span key="txn" className="font-mono font-bold text-slate-900">
        {r.txn}
      </span>,
      <span key="deal" className="font-semibold text-blue-600">
        {r.request_no}
      </span>,
      <span key="party" className="text-slate-600">
        {r.counterparty}
      </span>,
      <span
        key="dir"
        className={`font-bold ${r.direction === "IN" ? "text-green-600" : "text-slate-600"}`}
      >
        {r.direction}
      </span>,
      <span
        key="amount"
        className={`text-right font-bold tabular-nums ${
          r.direction === "IN" ? "text-green-600" : "text-slate-900"
        }`}
      >
        {r.direction === "IN" ? "+" : "−"}
        {inr(r.amount).slice(1)}
      </span>,
      <span
        key="method"
        className="inline-flex rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600"
      >
        {r.method}
      </span>,
      <span key="date" className="text-slate-500">
        {r.txn_date}
      </span>,
      <span key="by" className="text-slate-500">
        {r.recorded_by ?? "—"}
      </span>,
    ],
  }));

  const r = reconciliation;

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader
          title="Transaction History"
          sub="Flat ledger of all settlement transactions"
          right={
            <a
              href={`/api/admin/buyback/ledger?format=csv&limit=${MAX_CSV_LIMIT}&from=${fromParam(dateFilter)}`}
              className="rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-[12.5px] font-semibold text-slate-600 hover:bg-slate-50"
            >
              Export CSV
            </a>
          }
        />

        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

        {/* THE RECONCILIATION INVARIANT. Shown pass or fail. */}
        {r && (
          <div
            className={`mb-4 rounded-[10px] border px-4 py-3 ${
              r.reconciled ? "border-green-200 bg-green-50" : "border-red-300 bg-red-50"
            }`}
          >
            <div
              className={`text-[11px] font-bold uppercase tracking-wide ${
                r.reconciled ? "text-green-700" : "text-red-700"
              }`}
            >
              {r.reconciled ? "Reconciled" : "DOES NOT RECONCILE"}
            </div>
            <p className={`mt-0.5 text-[13px] ${r.reconciled ? "text-green-900" : "text-red-800"}`}>
              {r.reconciled ? (
                <>
                  Money that actually moved on closed deals nets to <b>{inr(r.ledger_net)}</b> —
                  exactly what the locked prices say we earned.
                  {r.uplift > 0 && (
                    <span className="text-green-700">
                      {" "}
                      {inr(r.uplift)} of that is above the margin we planned — the value of
                      haggling vendors up from our ask.
                    </span>
                  )}
                </>
              ) : (
                <>
                  The ledger nets to <b>{inr(r.ledger_net)}</b> but the locked prices say the
                  margin should be <b>{inr(r.expected_margin)}</b>, a difference of{" "}
                  <b>{inr(Math.abs(r.difference))}</b>. A report is reporting a margin that was
                  never earned. Investigate before trusting any dashboard.
                </>
              )}
            </p>
          </div>
        )}

        {!loading && (
          <>
            <div className="mb-4 grid grid-cols-1 gap-3.5 sm:grid-cols-3">
              <KpiCard label="Total IN" value={inr(totals.in)} accent="text-green-600" />
              <KpiCard label="Total OUT" value={inr(totals.out)} accent="text-slate-600" />
              <KpiCard
                label="NET MARGIN REALIZED"
                value={inr(totals.net)}
                note="Money in minus money out, for the loaded window"
                variant="navy"
              />
            </div>

            <div className="mb-4 flex flex-wrap gap-2">
              <FilterPill
                label="Direction"
                value={directionFilter}
                options={directionOptions}
                onChange={setDirectionFilter}
              />
              <FilterPill
                label="Method"
                value={methodFilter}
                options={methodOptions}
                onChange={setMethodFilter}
              />
              <FilterPill
                label="Date range"
                value={dateFilter}
                options={DATE_RANGE_OPTIONS}
                onChange={setDateFilter}
              />
            </div>
          </>
        )}

        <Card>
          <DealTable
            heads={HEADS}
            rows={tableRows}
            loading={loading ? "Loading…" : undefined}
            empty={!loading ? "No settlements recorded yet." : undefined}
          />
          {/* Load more: the date-window page is capped at FETCH_LIMIT rows;
              this pulls the next page in from the server. */}
          {!loading && hasMore && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full border-t border-[#F4F6F9] px-[18px] py-3 text-center text-[12.5px] font-semibold text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loadingMore ? "Loading…" : `Load more (${rows.length} shown)`}
            </button>
          )}
        </Card>
      </div>
    </div>
  );
}
