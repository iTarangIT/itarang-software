"use client";

/**
 * Quotation Inbox — the lots iTarang has just quoted this vendor and is waiting
 * to hear back on (status SENT). This is the "new quotations" slice of
 * /api/vendor/threads; the count here is what the sidebar's inbox badge shows.
 * Each row's "Respond" opens the counter/accept/decline flow.
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

export default function VendorInboxPage() {
  const { threads, loading, error, reload } = useVendorThreads();
  const [active, setActive] = useState<VendorThread | null>(null);
  const [detail, setDetail] = useState<VendorThread | null>(null);

  const inbox = threads
    .filter((t) => t.status === "SENT")
    .sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""));

  const rows: DealTableRow[] = inbox.map((t) => {
    const topAsk = topPerUnit(t.lines.map((l) => l.ask_price));
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
        <span key="received" className="text-slate-500">
          {fmtDate(t.sent_at)}
        </span>,
        <VendorStatusPill key="status" status={t.status} />,
        <button
          key="act"
          onClick={(e) => {
            e.stopPropagation();
            setActive(t);
          }}
          className="rounded-lg bg-bb-navy px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90"
        >
          Respond
        </button>,
      ],
    };
  });

  return (
    <VendorPageShell
      title="Quotation Inbox"
      subtitle="New battery lots iTarang has quoted you — respond with a counter, accept, or decline"
    >
      {error || loading ? (
        <VendorStateNote loading={loading} error={error} />
      ) : inbox.length === 0 ? (
        <EmptyState
          icon="📭"
          title="No new quotations"
          body="You're all caught up. New battery lots iTarang quotes you will land here."
        />
      ) : (
        <Card title="New quotations">
          <DealTable
            heads={[
              { label: "Lot" },
              { label: "Batteries" },
              { label: "Top Ask" },
              { label: "Received" },
              { label: "Status" },
              { label: "" },
            ]}
            rows={rows}
            empty="No new quotations right now."
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
