"use client";

/**
 * Payments — what this vendor owes iTarang against won lots. A vendor is never
 * shown the dealer-side settlement ledger, so "due" here is the outstanding
 * proforma-invoice value across AGREED lots (proforma = our statement of what
 * they'll pay), with a link to each proforma PDF.
 */

import { Card, DealTable, EmptyState, KpiCard } from "@/components/buyback/ui";
import type { DealTableRow } from "@/components/buyback/ui";
import { inr } from "@/lib/buyback/format";

import { useVendorThreads, VendorPageShell, VendorStateNote } from "../_shared";

export default function VendorPaymentsPage() {
  const { threads, loading, error } = useVendorThreads();

  const withProforma = threads
    .filter((t) => t.status === "AGREED" && t.proforma)
    .sort((a, b) => (b.responded_at ?? "").localeCompare(a.responded_at ?? ""));

  const totalDue = withProforma.reduce((sum, t) => sum + (t.proforma?.total ?? 0), 0);

  const rows: DealTableRow[] = withProforma.map((t) => ({
    key: t.thread_id,
    cells: [
      <span key="lot" className="font-bold text-slate-900">
        {t.quotation_no}
      </span>,
      <span key="pi" className="text-slate-600">
        {t.proforma?.number ?? "—"}
      </span>,
      <span key="amt" className="tabular-nums font-semibold text-slate-900">
        {inr(t.proforma?.total ?? null)}
      </span>,
      t.proforma?.pdf_available ? (
        <a
          key="doc"
          href={`/api/vendor/threads/${t.thread_id}/proforma`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-slate-300 px-2.5 py-1 text-[11.5px] font-semibold text-slate-600 hover:bg-slate-50"
        >
          Download
        </a>
      ) : (
        <span key="doc" className="text-slate-400">
          —
        </span>
      ),
    ],
  }));

  return (
    <VendorPageShell
      title="Payments"
      subtitle="What you owe iTarang against the lots you've won"
    >
      {error || loading ? (
        <VendorStateNote loading={loading} error={error} />
      ) : withProforma.length === 0 ? (
        <EmptyState
          icon="💳"
          title="Nothing due"
          body="When you win a lot and we issue a proforma invoice against your PO, it shows up here."
        />
      ) : (
        <>
          <div className="mb-[18px] grid grid-cols-2 gap-3.5 sm:grid-cols-4">
            <KpiCard label="Payments Due" value={inr(totalDue)} accent="text-teal-600" />
            <KpiCard label="Open Invoices" value={withProforma.length} accent="text-slate-900" />
          </div>

          <Card title="Proforma invoices">
            <DealTable
              heads={[
                { label: "Lot" },
                { label: "Invoice #" },
                { label: "Amount" },
                { label: "Document" },
              ]}
              rows={rows}
              empty="No invoices yet."
            />
          </Card>
        </>
      )}
    </VendorPageShell>
  );
}
