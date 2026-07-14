"use client";

/**
 * Deal status chips. The label/colour tokens come straight from the design
 * handoff, in ONE place — the prototype repeated them per screen.
 */

import type { DealState } from "@/lib/buyback/state-machine";

const STATUS: Record<string, { label: string; className: string }> = {
  DRAFT: { label: "Draft", className: "bg-slate-100 text-slate-600" },
  SUBMITTED: { label: "Submitted", className: "bg-blue-50 text-blue-600" },
  UNDER_REVIEW: { label: "Under Review", className: "bg-blue-50 text-blue-600" },
  INFO_REQUESTED: { label: "Info Requested", className: "bg-amber-100 text-amber-700" },
  NEGOTIATING: { label: "Negotiating", className: "bg-amber-100 text-amber-700" },
  FINAL_OFFER_SENT: { label: "Final Offer Sent", className: "bg-amber-100 text-amber-700" },
  DEALER_ACCEPTED: { label: "Dealer Accepted", className: "bg-emerald-100 text-emerald-700" },
  MARGIN_SET: { label: "Margin Set", className: "bg-emerald-100 text-emerald-700" },
  VENDOR_ROUTED: { label: "Vendor Routed", className: "bg-blue-50 text-blue-600" },
  VENDOR_NEGOTIATING: { label: "Vendor Negotiating", className: "bg-amber-100 text-amber-700" },
  VENDOR_AGREED: { label: "Vendor Agreed", className: "bg-emerald-100 text-emerald-700" },
  DEALER_REOPENED: { label: "Reopened", className: "bg-amber-100 text-amber-700" },
  PO_EXCHANGED: { label: "PO Exchanged", className: "bg-blue-50 text-blue-600" },
  PICKUP_SCHEDULED: { label: "Pickup Scheduled", className: "bg-teal-100 text-teal-700" },
  PICKED_UP: { label: "Picked Up", className: "bg-teal-100 text-teal-700" },
  INVOICE_RAISED: { label: "Invoice Raised", className: "bg-blue-50 text-blue-600" },
  INVOICE_APPROVED: { label: "Invoice Approved", className: "bg-emerald-100 text-emerald-700" },
  SETTLED: { label: "Settled", className: "bg-emerald-100 text-emerald-700" },
  CLOSED: { label: "Closed", className: "bg-emerald-100 text-emerald-800" },
  REJECTED: { label: "Rejected", className: "bg-red-100 text-red-700" },
  CANCELLED: { label: "Cancelled", className: "bg-red-100 text-red-700" },
};

export default function StatusChip({ status }: { status: DealState | string }) {
  const s = STATUS[status] ?? { label: status, className: "bg-slate-100 text-slate-600" };

  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-[3px] text-[11px] font-bold tracking-wide ${s.className}`}
    >
      {s.label}
    </span>
  );
}

/** "Offer v2" — only shown once a reopen has bumped the version. */
export function OfferVersionChip({ version }: { version: number }) {
  if (version <= 1) return null;
  return (
    <span className="inline-flex rounded-md bg-slate-100 px-2 py-[3px] text-[11px] font-bold text-slate-600">
      Offer v{version}
    </span>
  );
}
