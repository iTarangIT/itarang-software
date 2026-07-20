"use client";

/**
 * Quotation detail (read-only) — the full lot as the vendor sees it: every SKU
 * with its condition, quantity, our ask, their last bid and the agreed price,
 * plus the battery PHOTOS. Opened by clicking a quotation row anywhere in the
 * vendor portal. If the lot is still open, "Respond" hands off to RespondModal.
 *
 * Masking holds: the thread payload never carried dealer identity, and a photo
 * is a property of the battery — the same images already reach the vendor as the
 * quotation email's attachments. Photos are served (EXIF-stripped display copy)
 * by the vendor-scoped /photo endpoint, which re-checks ownership per id.
 */

import { useState } from "react";

import { inr } from "@/lib/buyback/format";

import { fmtDate, perUnitLabel, VendorStatusPill, type VendorThread } from "./_shared";

/** The EXIF-stripped display copy (1024px) — large enough for the lightbox too. */
function photoSrc(threadId: string, photoId: string): string {
  return `/api/vendor/threads/${threadId}/photo?photo=${photoId}&size=thumb`;
}

export function QuotationDetailModal({
  thread,
  onClose,
  onRespond,
}: {
  thread: VendorThread;
  onClose: () => void;
  onRespond?: () => void;
}) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  const location = [thread.pickup_city, thread.pickup_state].filter(Boolean).join(", ") || "—";

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
          <Meta label="Sent" value={fmtDate(thread.sent_at)} />
          <Meta label="Last update" value={fmtDate(thread.responded_at ?? thread.sent_at)} />
        </div>

        <div className="mt-4 space-y-3">
          {thread.lines.map((l) => (
            <div key={l.line_id} className="rounded-xl border border-slate-200 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold text-slate-900">{l.spec_label}</span>
                <span className="text-[11.5px] text-slate-500">
                  {l.condition} · {l.quantity} units
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
                <Price label="Our ask" value={l.ask_price} />
                <Price label="Your bid" value={l.counter_price} />
                <Price label="Agreed" value={l.agreed_price} />
              </div>

              {l.photos.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {l.photos.map((p) => {
                    const src = photoSrc(thread.thread_id, p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setLightbox(src)}
                        className="h-16 w-16 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 hover:opacity-90"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src} alt="Battery" className="h-full w-full object-cover" loading="lazy" />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-slate-400">No photos for this battery.</p>
              )}
            </div>
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

      {lightbox && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox}
            alt="Battery"
            className="max-h-full max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setLightbox(null)}
            aria-label="Close"
            className="absolute right-5 top-5 text-3xl leading-none text-white/80 hover:text-white"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-[12.5px] font-semibold text-slate-800">{value}</div>
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
