"use client";

/**
 * THE battery card a scrap vendor reads before naming a price — shared by the
 * Respond modal and the read-only quotation detail.
 *
 * One component rather than one per modal, for the same reason format.ts holds
 * one line formatter: the two views had already drifted (detail showed photos,
 * respond showed a bare "62V 33Ah · Dead") and a vendor pricing from the respond
 * modal was working off strictly less than the quotation PDF in their inbox.
 *
 * What is on the card, in the order a scrap buyer actually reads it:
 *   · the photos — the only evidence of what the pack is really like
 *   · condition and, where declared, the working/non-working/untested split
 *   · the kilograms, called out rather than buried in the meta line, because a
 *     recycler prices by weight before anything else
 *   · the rest of the declared spec, from the shared vendorLineMeta formatter
 *
 * Masking holds throughout: every field here is a property of the BATTERY. A
 * photo is a property of the battery too — the same images already reach this
 * vendor as the quotation email's attachments — and the bytes come from the
 * vendor-scoped photo route, which re-checks ownership per id.
 */

import { useState } from "react";
import type { ReactNode } from "react";

import { vendorLineMeta } from "@/lib/buyback/format";

import type { VendorLine } from "./_shared";

/** The EXIF-stripped display copy (1024px) — large enough for the lightbox too. */
export function photoSrc(threadId: string, photoId: string): string {
  return `/api/vendor/threads/${threadId}/photo?photo=${photoId}&size=thumb`;
}

/** Trailing-zero-free kilograms: "50.000" → "50", "11.500" → "11.5". */
function kg(value: number | string | null): string | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? String(Number(n.toFixed(2))) : null;
}

/**
 * Photo strip with a click-to-enlarge lightbox.
 *
 * Lifted state, so a card can host the strip while the modal owns the overlay —
 * a lightbox rendered inside a scrolling card would be clipped by it.
 */
export function useLightbox() {
  const [src, setSrc] = useState<string | null>(null);

  const overlay = src ? (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-6"
      onClick={() => setSrc(null)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="Battery"
        className="max-h-full max-w-full rounded-lg object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        onClick={() => setSrc(null)}
        aria-label="Close photo"
        className="absolute right-5 top-5 text-3xl leading-none text-white/80 hover:text-white"
      >
        ×
      </button>
    </div>
  ) : null;

  return { open: setSrc, overlay };
}

function PhotoStrip({
  threadId,
  line,
  onOpen,
}: {
  threadId: string;
  line: VendorLine;
  onOpen: (src: string) => void;
}) {
  if (line.photos.length === 0) {
    return (
      <p className="mt-2.5 rounded-lg border border-dashed border-slate-200 px-3 py-2 text-[11.5px] text-slate-400">
        The dealer sent no photos of this battery.
      </p>
    );
  }

  return (
    <div className="-mx-0.5 mt-2.5 flex gap-2 overflow-x-auto px-0.5 pb-1">
      {line.photos.map((p, i) => {
        const src = photoSrc(threadId, p.id);
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpen(src)}
            aria-label={`Enlarge photo ${i + 1} of ${line.photos.length} for ${line.spec_label}`}
            className="h-[72px] w-[72px] shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 transition hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-bb-navy/40"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={`${line.spec_label} battery`}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </button>
        );
      })}
    </div>
  );
}

/**
 * One battery, everything declared about it, with room for the caller's own
 * controls underneath — the price input in the Respond modal, the ask/bid/agreed
 * summary in the read-only view.
 */
export function BatteryCard({
  threadId,
  line,
  onOpenPhoto,
  children,
}: {
  threadId: string;
  line: VendorLine;
  onOpenPhoto: (src: string) => void;
  children?: ReactNode;
}) {
  const dead = line.condition_key === "DEAD";
  const unitKg = kg(line.unit_weight_kg);
  const lineKg = kg(line.line_weight_kg);

  // The kilograms and the condition split come out of the meta line and stand on
  // their own: they are what the price is actually built from. Everything else —
  // brand, chemistry, form factor, nominal rating, rated cycles, IOT — stays in
  // the shared dotted line, in the same order the quotation PDF prints it.
  const meta = vendorLineMeta({ ...line, unit_weight_kg: null, line_weight_kg: null });

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-[14px] font-bold text-slate-900">{line.spec_label}</span>
        <span
          className={`rounded-md px-2 py-[2px] text-[10.5px] font-bold ${
            dead ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"
          }`}
        >
          {line.condition}
        </span>
        <span className="ml-auto text-[12px] font-semibold text-slate-500">
          {line.quantity} {line.quantity === 1 ? "unit" : "units"}
        </span>
      </div>

      <PhotoStrip threadId={threadId} line={line} onOpen={onOpenPhoto} />

      {(lineKg || line.condition_split_label) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          {lineKg && (
            <span className="text-[12.5px] text-slate-500">
              <span className="text-[13.5px] font-bold tabular-nums text-slate-900">
                {lineKg} kg
              </span>{" "}
              in this line{unitKg ? ` · ${unitKg} kg each` : ""}
            </span>
          )}
          {line.condition_split_label && (
            <span className="text-[12.5px] text-slate-600">{line.condition_split_label}</span>
          )}
        </div>
      )}

      {meta.length > 0 && (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">{meta.join(" · ")}</p>
      )}

      {children}
    </div>
  );
}
