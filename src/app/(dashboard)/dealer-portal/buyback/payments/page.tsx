"use client";

/**
 * Dealer Payments — their payouts from iTarang (design handoff
 * iTarang Portal.dc.html scrDealerPayments, lines 768-773).
 *
 * Data: the dealer list endpoint's Ext-9 `payout` field. The amount is the
 * deal's LOCKED dealer total, `paid` means the -D settlement leg exists, and
 * the txn_ref is that leg's — the API serializes it through toDealerPayout,
 * so the vendor leg (the other half of the margin) is structurally absent.
 * Requests whose deal has not reached the money stage (payout null) don't
 * appear here at all.
 *
 * The Transaction column falls back to the deterministic `TXN-{n}-D` sub-id
 * (the same derivation as the request detail's Payments tab) when the
 * recorded settlement carries no bank reference yet.
 *
 * Route precedence: static `payments` segment beside `[id]` — Next resolves
 * the static segment first (same note as requests/page.tsx).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { DealerRequestRow } from "@/components/buyback/DealerRequestsTable";
import StatusChip from "@/components/buyback/StatusChip";
import { Card, DealTable, EmptyState, PageHeader } from "@/components/buyback/ui";
import type { DealTableHead, DealTableRow } from "@/components/buyback/ui";
import { inr } from "@/lib/buyback/format";

/** Ext-9 — the dealer-safe payout summary on GET /api/buyback/requests. */
interface PayoutSummary {
  amount: number;
  paid: boolean;
  txn_ref: string | null;
}

interface RowWithPayout extends DealerRequestRow {
  payout: PayoutSummary | null;
}

const HEADS: DealTableHead[] = [
  { label: "Deal" },
  { label: "Transaction" },
  { label: "Amount", align: "right" },
  { label: "Status" },
];

export default function DealerPaymentsPage() {
  const router = useRouter();
  const [requests, setRequests] = useState<RowWithPayout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/buyback/requests")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) {
          setError(j?.error?.message ?? "Could not load your payments.");
          return;
        }
        setRequests(j?.data?.requests ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load your payments.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const withPayout = requests.filter((r) => r.payout != null);

  const rows: DealTableRow[] = withPayout.map((r) => ({
    key: r.request_id,
    onClick: () => router.push(`/dealer-portal/buyback/${r.request_id}`),
    ariaLabel: `Open ${r.request_no}`,
    cells: [
      <Link
        key="deal"
        href={`/dealer-portal/buyback/${r.request_id}`}
        className="font-bold text-slate-900 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {r.request_no}
      </Link>,
      <span key="txn" className="text-slate-600">
        {r.payout!.txn_ref ?? `TXN-${r.request_no.replace(/^BB-/, "")}-D`}
      </span>,
      <div key="amount" className="text-right font-semibold tabular-nums text-slate-900">
        {inr(r.payout!.amount)}
      </div>,
      r.payout!.paid ? (
        <StatusChip key="status" status="SETTLED" />
      ) : (
        <span
          key="status"
          className="inline-flex rounded-full bg-amber-100 px-2.5 py-[3px] text-[11px] font-bold text-amber-700"
        >
          Pending
        </span>
      ),
    ],
  }));

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader title="Payments" sub="Your payouts from iTarang" />

        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : !loading && withPayout.length === 0 ? (
          <EmptyState
            icon="💰"
            title="No payments yet"
            body="Payouts appear after your invoice is approved."
          />
        ) : (
          <>
            <Card>
              <DealTable
                heads={HEADS}
                rows={rows}
                loading={loading ? "Loading…" : undefined}
              />
            </Card>
            <p className="mt-2.5 text-[12px] text-slate-400">
              You only see your payout. Margin and vendor pricing are never shown to dealers.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
