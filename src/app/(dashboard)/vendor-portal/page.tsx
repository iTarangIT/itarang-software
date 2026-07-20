"use client";

/**
 * The scrap vendor's dashboard (E-195, BRD M24) — the overview screen.
 *
 * Until now a vendor had no login at all. They received a quotation PDF by
 * email and replied to it, and an admin typed their answer into the admin
 * screen. This is the vendor's own home: a funnel of their quotation activity
 * (new / bidding / won / lost), what they owe on won lots, and a peek at the
 * most recent lots. The detailed, actionable screens hang off the sidebar
 * (Quotation Inbox, My Bids, Orders & Documents, Payments).
 *
 * Everything here comes from useVendorThreads() → /api/vendor/threads, scoped
 * to this vendor and masked twice over (see _shared.tsx / toVendorThread).
 */

import { useState } from "react";
import Link from "next/link";

import { Card, DealTable, EmptyState, KpiCard } from "@/components/buyback/ui";
import type { DealTableRow } from "@/components/buyback/ui";
import BuybackActionCenter from "@/components/buyback/notifications/BuybackActionCenter";
import { inr } from "@/lib/buyback/format";

import { QuotationDetailModal } from "./_detail-modal";
import { RespondModal } from "./_respond-modal";
import {
  perUnitLabel,
  topPerUnit,
  useVendorThreads,
  VendorPageShell,
  VendorStateNote,
  VendorStatusPill,
  type VendorThread,
} from "./_shared";

export default function VendorPortalPage() {
  const { threads, loading, error, reload } = useVendorThreads();
  const [detail, setDetail] = useState<VendorThread | null>(null);
  const [active, setActive] = useState<VendorThread | null>(null);

  /* Stat-card figures — all derived from this vendor's own threads. The vendor
     thread status IS the funnel: SENT (new) → COUNTERED (bidding) → AGREED
     (won) / LOST. "Payments due" is the outstanding proforma value across won
     lots; a vendor is never shown the dealer-side paid/unpaid ledger, so this
     is the closest first-class figure we can surface here. */
  const newQuotations = threads.filter((t) => t.status === "SENT").length;
  const activeBids = threads.filter((t) => t.status === "COUNTERED").length;
  const won = threads.filter((t) => t.status === "AGREED").length;
  const lost = threads.filter((t) => t.status === "LOST").length;
  const paymentsDue = threads
    .filter((t) => t.status === "AGREED" && t.proforma)
    .reduce((sum, t) => sum + (t.proforma?.total ?? 0), 0);

  const recent = [...threads]
    .sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""))
    .slice(0, 6);

  const recentRows: DealTableRow[] = recent.map((t) => {
    const topAsk = topPerUnit(t.lines.map((l) => l.ask_price));
    const lastBid = topPerUnit(t.lines.map((l) => l.counter_price));
    return {
      key: t.thread_id,
      onClick: () => setDetail(t),
      ariaLabel: `Open ${t.quotation_no ?? "quotation"}`,
      cells: [
        <span key="lot" className="font-bold text-slate-900">
          {t.quotation_no}
        </span>,
        <span key="batteries" className="text-slate-600">
          <span className="text-blue-600">{t.total_units} units</span> · {t.lines.length} SKU
        </span>,
        <span key="ask" className="tabular-nums text-slate-700">
          {perUnitLabel(topAsk)}
        </span>,
        <span key="bid" className="tabular-nums text-slate-700">
          {perUnitLabel(lastBid)}
        </span>,
        <VendorStatusPill key="status" status={t.status} />,
      ],
    };
  });

  return (
    <VendorPageShell title="Vendor Dashboard" badge="V1.1 Preview">
      <BuybackActionCenter className="mb-5" />
      {error || loading ? (
        <VendorStateNote loading={loading} error={error} />
      ) : threads.length === 0 ? (
        /* The expected first-run state: a freshly registered vendor is already
           routable but simply has no lots yet — iTarang sends them one when a
           matching deal comes up. Saying so stops an empty dashboard reading as
           a broken portal. */
        <EmptyState
          icon="📭"
          title="No quotations yet"
          body="When iTarang has a battery lot for you, it will appear here."
        />
      ) : (
        <>
          <div className="mb-[18px] grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-5">
            <KpiCard label="New Quotations" value={newQuotations} accent="text-amber-600" />
            <KpiCard label="Active Bids" value={activeBids} accent="text-amber-500" />
            <KpiCard label="Won" value={won} accent="text-green-600" />
            <KpiCard label="Lost" value={lost} accent="text-red-600" />
            <KpiCard
              label="Payments Due"
              value={inr(paymentsDue)}
              accent="text-teal-600"
              note="across won lots"
            />
          </div>

          <Card
            title="Recent quotations"
            action={
              <Link
                href="/vendor-portal/bids"
                className="text-[12.5px] font-semibold text-teal-700 hover:underline"
              >
                View all bids →
              </Link>
            }
          >
            <DealTable
              heads={[
                { label: "Lot" },
                { label: "Batteries" },
                { label: "Top Ask" },
                { label: "Your Last Bid" },
                { label: "Status" },
              ]}
              rows={recentRows}
              empty="No quotations yet."
            />
          </Card>
        </>
      )}

      {detail && (
        <QuotationDetailModal
          thread={detail}
          onClose={() => setDetail(null)}
          onRespond={() => {
            setActive(detail);
            setDetail(null);
          }}
        />
      )}

      {active && (
        <RespondModal thread={active} onClose={() => setActive(null)} onDone={reload} />
      )}
    </VendorPageShell>
  );
}
