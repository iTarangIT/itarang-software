"use client";

/**
 * Quotation detail (read-only) — the full lot as the vendor sees it: every SKU
 * with its photos and declared spec, plus our ask, their last bid and the agreed
 * price. Opened by clicking a quotation row anywhere in the vendor portal. If
 * the lot is still open, "Respond" hands off to RespondModal.
 *
 * The battery itself is rendered by the shared BatteryCard, the same one the
 * Respond modal uses — this file owns only what is specific to a read-only view:
 * the lot totals, the three prices per line, and the handoff. When the two
 * screens each owned their own battery markup they immediately disagreed about
 * what a vendor may see, which is the whole reason the card is shared.
 *
 * Masking holds: the thread payload never carried dealer identity, and a photo
 * is a property of the battery — the same images already reach the vendor as the
 * quotation email's attachments. Photos are served (EXIF-stripped display copy)
 * by the vendor-scoped /photo endpoint, which re-checks ownership per id.
 */

import { inr } from "@/lib/buyback/format";

import { BatteryCard, useLightbox } from "./_battery-lines";
import {
  fmtDate,
  lotWeight,
  perUnitLabel,
  VendorStatusPill,
  type VendorThread,
} from "./_shared";

export function QuotationDetailModal({
  thread,
  onClose,
  onRespond,
}: {
  thread: VendorThread;
  onClose: () => void;
  onRespond?: () => void;
}) {
  const lightbox = useLightbox();
  const location = [thread.pickup_city, thread.pickup_state].filter(Boolean).join(", ") || "—";
  const weight = lotWeight(thread.lines);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-bold text-slate-900">{thread.quotation_no}</span>
              <VendorStatusPill status={thread.status} />
            </div>
            <div className="mt-0.5 text-[12px] text-slate-500">
              {thread.total_units} units · {thread.lines.length} SKU · Pickup {location}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mt-1 text-2xl leading-none text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-slate-50 px-3 py-2.5 sm:grid-cols-4">
          <Meta label="Our ask total" value={thread.ask_total !== null ? inr(thread.ask_total) : "—"} />
          <Meta label="Your bid total" value={thread.counter_total !== null ? inr(thread.counter_total) : "—"} />
          {/* Weight sits with the money because for a recycler it IS the money.
              Caveated when only some SKUs declared one — a total that silently
              covers three of five is a number the vendor will price against
              believing it covers the lot. */}
          <Meta
            label="Declared weight"
            value={weight ? `${weight.kg} kg` : "—"}
            note={weight && weight.declared < weight.of ? `${weight.declared} of ${weight.of} SKUs` : null}
          />
          <Meta label="Sent" value={fmtDate(thread.sent_at)} />
        </div>

        <div className="mt-4 space-y-2.5">
          {thread.lines.map((l) => (
            <BatteryCard
              key={l.line_id}
              threadId={thread.thread_id}
              line={l}
              onOpenPhoto={lightbox.open}
            >
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-100 pt-2.5 text-[12px]">
                <Price label="Our ask" value={l.ask_price} />
                <Price label="Your bid" value={l.counter_price} />
                <Price label="Agreed" value={l.agreed_price} />
              </div>
            </BatteryCard>
          ))}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          {thread.can_respond && onRespond && (
            <button
              onClick={onRespond}
              className="rounded-lg bg-bb-navy px-4 py-2 text-[12.5px] font-semibold text-white hover:opacity-90"
            >
              Respond to this quotation
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-[12.5px] font-semibold text-slate-600 hover:bg-slate-50"
          >
            Close
          </button>
        </div>
      </div>

      {lightbox.overlay}
    </div>
  );
}

function Meta({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-[12.5px] font-semibold text-slate-800">{value}</div>
      {note && <div className="text-[10.5px] text-amber-700">{note}</div>}
    </div>
  );
}

function Price({ label, value }: { label: string; value: number | string | null }) {
  const n = value === null || value === "" ? null : Number(value);
  const shown = n === null || !Number.isFinite(n) ? "—" : perUnitLabel(n);
  return (
    <span className="text-slate-600">
      {label}: <span className="font-semibold tabular-nums text-slate-800">{shown}</span>
    </span>
  );
}
