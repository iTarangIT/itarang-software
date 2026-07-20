"use client";

/**
 * My Bids — this vendor's full quotation activity across every lot, showing
 * what iTarang asked (Top Ask), what the vendor last offered (Your Last Bid),
 * and where each one stands. Open lots (SENT / COUNTERED) can be responded to
 * from here; closed ones (AGREED / LOST) are read-only.
 */

import { useState } from "react";

import { Card, DealTable, EmptyState } from "@/components/buyback/ui";
import type { DealTableRow } from "@/components/buyback/ui";

import { QuotationDetailModal } from "../_detail-modal";
import { RespondModal } from "../_respond-modal";
import {
  fmtDate,
  perUnitLabel,
  topPerUnit,
  useVendorThreads,
  VendorPageShell,
  VendorStateNote,
  VendorStatusPill,
  type VendorThread,
} from "../_shared";

export default function VendorBidsPage() {
  const { threads, loading, error, reload } = useVendorThreads();
  const [active, setActive] = useState<VendorThread | null>(null);
  const [detail, setDetail] = useState<VendorThread | null>(null);

  const all = [...threads].sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""));

  const rows: DealTableRow[] = all.map((t) => {
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
        <span key="updated" className="text-slate-500">
          {fmtDate(t.responded_at ?? t.sent_at)}
        </span>,
        <VendorStatusPill key="status" status={t.status} />,
        t.can_respond ? (
          <button
            key="act"
            onClick={(e) => {
              e.stopPropagation();
              setActive(t);
            }}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50"
          >
            Respond
          </button>
        ) : (
          <span key="act" className="text-slate-300">
            —
          </span>
        ),
      ],
    };
  });

  return (
    <VendorPageShell
      title="My Bids"
      subtitle="Every lot you've been quoted — your ask, your last bid, and where it stands"
    >
      {error || loading ? (
        <VendorStateNote loading={loading} error={error} />
      ) : all.length === 0 ? (
        <EmptyState
          icon="🤝"
          title="No bids yet"
          body="Once iTarang quotes you a battery lot, your bidding activity will show up here."
        />
      ) : (
        <Card title="All quotations">
          <DealTable
            heads={[
              { label: "Lot" },
              { label: "Batteries" },
              { label: "Top Ask" },
              { label: "Your Last Bid" },
              { label: "Updated" },
              { label: "Status" },
              { label: "" },
            ]}
            rows={rows}
            empty="No bids yet."
          />
        </Card>
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
