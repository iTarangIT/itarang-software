"use client";

import type { ReactNode } from "react";

import { ConditionChip } from "@/components/buyback/BatteryLineLabel";
import { inr } from "@/lib/buyback/format";

import Card from "./Card";

export interface BuybackLinePhoto {
  thumbUrl?: string;
}

export interface BuybackLineProvenance {
  kind: "owner" | "stock";
  ownerName?: string;
  phone?: string;
  vehicle?: string;
  idProof?: string;
  purchaseProof?: string;
}

export interface BuybackLineView {
  id: string;
  /** Caller-supplied — pass a <BatteryLineLabel/> element (reused, not reimplemented). */
  label: ReactNode;
  qty: number;
  condition: string;
  spec?: string;
  measured?: string;
  expectedPerUnit?: number;
  lockedPerUnit?: number;
  lineTotal?: number;
  photos?: BuybackLinePhoto[];
  provenance?: BuybackLineProvenance;
}

const PHOTO_PLACEHOLDER = "bg-[repeating-linear-gradient(135deg,#E2E8F0,#E2E8F0_5px,#EDF1F5_5px,#EDF1F5_10px)]";

function ownerProvenanceLine(p: BuybackLineProvenance): string {
  const parts: string[] = [];
  if (p.ownerName) parts.push(p.ownerName);
  if (p.phone) parts.push(p.phone);
  if (p.vehicle) parts.push(`Vehicle ${p.vehicle}`);
  if (p.idProof) parts.push(p.idProof);
  if (p.purchaseProof) parts.push(`Purchase proof ${p.purchaseProof}`);
  return parts.join(" · ");
}

/**
 * Battery-lines panel — proto linesTable() (iTarang Portal.dc.html:666-687).
 * `label` is a slot the caller fills with <BatteryLineLabel/>; the meta row
 * below still carries its own condition chip via the SAME ConditionChip
 * export (src/components/buyback/BatteryLineLabel.tsx) rather than a second
 * color map, per the design's two-row layout (bold SKU line, then a
 * qty/condition/spec/measured/expected summary line underneath).
 *
 * "use client" — the photo squares attach onClick when `onPhotoClick` is
 * passed, which is illegal from a Server Component.
 */
export default function LinesCard({
  lines,
  title = "Battery lines",
  totalLabel,
  totalValue,
  onPhotoClick,
}: {
  lines: BuybackLineView[];
  title?: string;
  totalLabel?: string;
  totalValue?: ReactNode;
  onPhotoClick?: (lineIdx: number, photoIdx: number) => void;
}) {
  return (
    <Card title={title}>
      {lines.map((line, li) => {
        const condition = (line.condition ?? "").toUpperCase() === "DEAD" ? "DEAD" : "WORKING";
        const photos = line.photos ?? [];

        return (
          <div key={line.id} className={`p-4 ${li < lines.length - 1 ? "border-b border-[#F4F6F9]" : ""}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[13.5px] font-bold">{line.label}</div>
                <div className="mt-[3px] flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  <span>{line.qty} units</span>
                  <span>·</span>
                  <ConditionChip condition={condition} />
                  {line.spec && <span>· {line.spec}</span>}
                  {line.measured && <span>· measured {line.measured}</span>}
                  {line.expectedPerUnit != null && <span>· Expected {inr(line.expectedPerUnit)}/unit</span>}
                </div>
                {line.lockedPerUnit != null && (
                  <div className="mt-[3px] text-[11.5px] font-bold text-green-700">
                    Locked {inr(line.lockedPerUnit)}/unit
                  </div>
                )}
              </div>
              {line.lineTotal != null && <div className="font-bold tabular-nums">{inr(line.lineTotal)}</div>}
            </div>

            {photos.length > 0 && (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {photos.map((photo, pi) => (
                  <button
                    key={pi}
                    type="button"
                    onClick={() => onPhotoClick?.(li, pi)}
                    title="Zoom evidence"
                    className={`h-11 w-11 shrink-0 rounded-md border border-gray-200 bg-cover bg-center ${
                      photo.thumbUrl ? "" : PHOTO_PLACEHOLDER
                    }`}
                    style={photo.thumbUrl ? { backgroundImage: `url(${photo.thumbUrl})` } : undefined}
                  />
                ))}
                <span className="text-[11px] text-slate-400">{photos.length} photos · click to zoom (evidence)</span>
              </div>
            )}

            {line.provenance && (
              <div className="mt-2.5 rounded-lg border border-slate-100 bg-[#FAFBFC] px-3 py-[9px] text-xs text-slate-600">
                {line.provenance.kind === "stock" ? (
                  <>
                    <b>Dealer own stock</b> · ID on file, no re-entry
                  </>
                ) : (
                  <>
                    <b>Owner:</b> {ownerProvenanceLine(line.provenance)}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}

      {(totalLabel || totalValue != null) && (
        <div className="flex items-center justify-between border-t border-gray-200 bg-[#F8FAFC] px-3 py-2 text-[12.5px] font-extrabold">
          <span>{totalLabel}</span>
          <span className="tabular-nums">{totalValue}</span>
        </div>
      )}
    </Card>
  );
}
