"use client";

/**
 * Payments & Settlement — both legs of every deal that has reached the money
 * stage (design handoff, iTarang Portal.dc.html `scrPayments`, lines
 * 1007-1037).
 *
 * Data is a MERGE of two existing, unmodified endpoints:
 *   - `/api/admin/buyback/reports?type=margin` — one row per deal with
 *     locked prices (deal_line_locks): dealer_total/vendor_total/
 *     realised_margin/status, plus request_id (Ext-6).
 *   - `/api/admin/buyback/ledger` — every settlement transaction actually
 *     recorded, keyed by `txn` (settlement_transactions.leg_sub_id).
 *
 * The two legs' transaction ids are DERIVABLE, not stored on the margin row:
 * `groupTxnId()`/`legSubId()` in src/lib/buyback/money.ts turn 'BB-1024' into
 * 'TXN-1024-D' / 'TXN-1024-V'. That module cannot be imported here — it owns
 * the `db` client and would drag the postgres driver into the browser bundle
 * (same reason the catalog page mirrors PRICE_REVIEW_INTERVAL_DAYS instead of
 * importing lib/buyback/catalog.ts) — so the two-line derivation is repeated
 * below, verbatim.
 *
 * A leg is "Settled" when the ledger contains a row whose `txn` equals the
 * derived id — this page never posts a settlement itself. Recording one is
 * the deal detail page's MoneyBoard (src/components/buyback/MoneyBoard.tsx);
 * "Record →" here deep-links to `/admin/buyback/{request_id}` rather than
 * duplicating that POST.
 *
 * SCOPE — which deals show up: the margin report returns a row for every deal
 * with locks, from MARGIN_SET onward (well before money moves). Restricting
 * to INVOICE_RAISED / INVOICE_APPROVED / SETTLED / CLOSED matches exactly the
 * set of statuses MoneyBoard itself renders a settlement UI for — a deal
 * listed here is guaranteed to have a working "Record" button on the other
 * end of the deep link.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { Card, EmptyState, PageHeader } from "@/components/buyback/ui";
import StatusChip from "@/components/buyback/StatusChip";
import { inr } from "@/lib/buyback/format";

interface MarginRow {
  request_id: string;
  request_no: string;
  dealer: string;
  vendor: string;
  status: string;
  dealer_total: number | string;
  vendor_total: number | string;
  realised_margin: number | string;
}

interface LedgerRow {
  txn: string;
}

// The money-stage statuses MoneyBoard itself gates settlement UI on.
const MONEY_STAGE_STATUSES = new Set(["INVOICE_RAISED", "INVOICE_APPROVED", "SETTLED", "CLOSED"]);

/** 'BB-1024' → 'TXN-1024' — mirrors lib/buyback/money.ts#groupTxnId. */
function groupTxnId(requestNo: string): string {
  return `TXN-${requestNo.replace(/^BB-/, "")}`;
}

/** 'BB-1024' + 'DEALER' → 'TXN-1024-D' — mirrors lib/buyback/money.ts#legSubId. */
function legSubId(requestNo: string, leg: "DEALER" | "VENDOR"): string {
  return `${groupTxnId(requestNo)}-${leg === "DEALER" ? "D" : "V"}`;
}

export default function AdminBuybackPaymentsPage() {
  const [marginRows, setMarginRows] = useState<MarginRow[]>([]);
  const [ledgerTxns, setLedgerTxns] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [marginJson, ledgerJson] = await Promise.all([
          fetch("/api/admin/buyback/reports?type=margin").then((r) => r.json()),
          fetch("/api/admin/buyback/ledger").then((r) => r.json()),
        ]);

        if (cancelled) return;

        const failed = [marginJson, ledgerJson].find((j) => j?.success === false);
        if (failed) {
          setError(failed?.error?.message ?? "Could not load payments & settlement.");
          return;
        }

        setMarginRows(marginJson?.data?.rows ?? []);
        setLedgerTxns(new Set((ledgerJson?.data?.rows ?? []).map((r: LedgerRow) => r.txn)));
      } catch {
        if (!cancelled) setError("Could not load payments & settlement.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const deals = marginRows.filter((r) => MONEY_STAGE_STATUSES.has(r.status));

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader
          title="Payments & Settlement"
          sub="Record and track both legs of every deal"
        />

        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : deals.length === 0 ? (
          <EmptyState
            icon="💰"
            title="Nothing to settle yet"
            body="Deals appear once invoices are raised."
          />
        ) : (
          <div className="space-y-4">
            {deals.map((d) => {
              const legs = (["DEALER", "VENDOR"] as const).map((leg) => {
                const txn = legSubId(d.request_no, leg);
                const settled = ledgerTxns.has(txn);
                return {
                  leg,
                  txn,
                  settled,
                  label: leg === "DEALER" ? "Dealer payout (OUT)" : "Vendor receipt (IN)",
                  amount: leg === "DEALER" ? d.dealer_total : d.vendor_total,
                };
              });

              return (
                <Card key={d.request_id}>
                  <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="font-bold text-slate-900">{d.request_no}</span>
                      <StatusChip status={d.status} />
                    </div>
                    <span className="text-[12px] text-slate-500">
                      Margin{" "}
                      <span className="font-bold text-green-600">{inr(d.realised_margin)}</span>
                    </span>
                  </div>

                  <div>
                    {legs.map((l) => (
                      <div
                        key={l.leg}
                        className="flex items-center justify-between border-b border-[#F4F6F9] px-4 py-3 last:border-b-0"
                      >
                        <div>
                          <div className="text-[13px] font-semibold text-slate-800">{l.label}</div>
                          <div className="text-[11.5px] text-slate-400">
                            {l.txn} · {inr(l.amount)}
                          </div>
                        </div>

                        {l.settled ? (
                          <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-[3px] text-[11px] font-bold text-green-700">
                            ✓ Settled
                          </span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-[3px] text-[11px] font-bold text-amber-700">
                              Pending
                            </span>
                            <Link
                              href={`/admin/buyback/${d.request_id}`}
                              className="rounded-lg border border-gray-200 px-3 py-1 text-[11.5px] font-semibold text-slate-600 hover:bg-slate-50"
                            >
                              Record →
                            </Link>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
