"use client";

/**
 * Payments — what this vendor owes iTarang against won lots. A vendor is never
 * shown the dealer-side settlement ledger, so "due" here is the outstanding
 * proforma-invoice value across AGREED lots (proforma = our statement of what
 * they'll pay), with a link to each proforma PDF.
 *
 * "Pay now" surfaces the vendor's own Razorpay payment link (E-193) in-app, so
 * they can pay from the portal instead of only from the emailed link. The link
 * data comes from /api/vendor/payment-links, which degrades to empty where the
 * gateway isn't configured — so this page never breaks, it just shows no pay
 * action until a link exists.
 */

import { useEffect, useState } from "react";

import { Card, DealTable, EmptyState, KpiCard } from "@/components/buyback/ui";
import type { DealTableRow } from "@/components/buyback/ui";
import { inr } from "@/lib/buyback/format";

import { useVendorThreads, VendorPageShell, VendorStateNote } from "../_shared";

interface PaymentLink {
  thread_id: string;
  status: string;
  short_url: string | null;
  amount: string | null;
  paid: boolean;
}

export default function VendorPaymentsPage() {
  const { threads, loading, error } = useVendorThreads();
  const [links, setLinks] = useState<Record<string, PaymentLink>>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/vendor/payment-links")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const list: PaymentLink[] = j?.data?.links ?? [];
        setLinks(Object.fromEntries(list.map((l) => [l.thread_id, l])));
      })
      .catch(() => {
        /* links are optional — a failure just means no in-app "Pay now" */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const withProforma = threads
    .filter((t) => t.status === "AGREED" && t.proforma)
    .sort((a, b) => (b.responded_at ?? "").localeCompare(a.responded_at ?? ""));

  const totalDue = withProforma
    .filter((t) => !links[t.thread_id]?.paid)
    .reduce((sum, t) => sum + (t.proforma?.total ?? 0), 0);

  const paidCount = withProforma.filter((t) => links[t.thread_id]?.paid).length;

  const rows: DealTableRow[] = withProforma.map((t) => {
    const link = links[t.thread_id];
    return {
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
        link?.paid ? (
          <span
            key="pay"
            className="inline-flex rounded-full bg-emerald-100 px-2.5 py-[3px] text-[11px] font-bold text-emerald-700"
          >
            Paid
          </span>
        ) : link?.short_url ? (
          <a
            key="pay"
            href={link.short_url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-green-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-green-700"
          >
            Pay now
          </a>
        ) : (
          <span key="pay" className="text-[11.5px] text-slate-400">
            Link pending
          </span>
        ),
      ],
    };
  });

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
            <KpiCard
              label="Open Invoices"
              value={withProforma.length - paidCount}
              accent="text-slate-900"
            />
          </div>

          <Card title="Proforma invoices">
            <DealTable
              heads={[
                { label: "Lot" },
                { label: "Invoice #" },
                { label: "Amount" },
                { label: "Document" },
                { label: "Pay" },
              ]}
              rows={rows}
              empty="No invoices yet."
            />
          </Card>

          <p className="mt-3 text-[11px] text-slate-400">
            Pay now appears here once iTarang issues your secure payment link (after your invoice
            is approved). You can also pay from the link we email you.
          </p>
        </>
      )}
    </VendorPageShell>
  );
}
