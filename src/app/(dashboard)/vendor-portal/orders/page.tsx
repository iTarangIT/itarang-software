"use client";

/**
 * Orders & Documents — the lots this vendor has won (status AGREED) and the
 * paperwork that follows: raise your purchase order, then download the proforma
 * invoice iTarang issues against it. This is where the PO/proforma flow lives.
 */

import { Card, EmptyState } from "@/components/buyback/ui";
import { inr } from "@/lib/buyback/format";

import {
  useVendorThreads,
  VendorPageShell,
  VendorPoPanel,
  VendorStateNote,
} from "../_shared";

export default function VendorOrdersPage() {
  const { threads, loading, error, reload } = useVendorThreads();

  const won = threads
    .filter((t) => t.status === "AGREED")
    .sort((a, b) => (b.responded_at ?? "").localeCompare(a.responded_at ?? ""));

  return (
    <VendorPageShell
      title="Orders & Documents"
      subtitle="Lots you've won — raise your PO and download the proforma invoice"
    >
      {error || loading ? (
        <VendorStateNote loading={loading} error={error} />
      ) : won.length === 0 ? (
        <EmptyState
          icon="📄"
          title="No orders yet"
          body="When you win a lot it appears here, with its purchase-order and invoice documents."
        />
      ) : (
        <Card title="Won lots">
          <ul className="divide-y divide-slate-100">
            {won.map((t) => (
              <li key={t.thread_id} className="px-[18px] py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px] font-bold text-slate-900">
                    {t.quotation_no}
                  </span>
                  <span className="text-[12.5px] text-slate-400">
                    {t.total_units} units · {t.lines.length} SKU
                    {t.pickup_city
                      ? ` · collect from ${[t.pickup_city, t.pickup_state]
                          .filter(Boolean)
                          .join(", ")}`
                      : ""}
                  </span>
                  <span className="ml-auto text-[13px] font-semibold tabular-nums text-slate-900">
                    {t.agreed_total !== null ? `${inr(t.agreed_total)} agreed` : "—"}
                  </span>
                </div>

                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                  {t.lines.map((l) => (
                    <span key={l.line_id} className="text-[12px] text-slate-500">
                      {l.spec_label} · {l.condition} ×{l.quantity}
                      {l.agreed_price !== null ? ` @ ${inr(Number(l.agreed_price))}/u` : ""}
                    </span>
                  ))}
                </div>

                {/* Server-gated: the PO input and proforma download only render
                    when the deal state actually allows them. */}
                {(t.can_raise_po || t.proforma) && (
                  <VendorPoPanel thread={t} onRaised={reload} />
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </VendorPageShell>
  );
}
