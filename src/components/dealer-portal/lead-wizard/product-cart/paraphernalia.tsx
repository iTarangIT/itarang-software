"use client";

import React from "react";
import { Minus, Package, Plus, X } from "lucide-react";

import { formatGstPct, inr, paraKey } from "./pricing";
import type { ParaRow } from "./types";

/**
 * BRD §SECTION D — the paraphernalia picker: SOC counts, a single harness
 * variant per lead, and a free multi-select over the rest of the dealer's
 * accessory stock.
 */

export function ParaphernaliaList({
  items,
  paraQty,
  onChangeQty,
  disabled,
}: {
  items: ParaRow[];
  paraQty: Record<string, number>;
  onChangeQty: (k: string, n: number, max: number) => void;
  disabled?: boolean;
}) {
  // BRD §SECTION D — four input types:
  //   1. Digital SOC      → quantity 0..N
  //   2. Volt SOC         → quantity 0..N
  //   3. Harness Variant  → dropdown (Type A / B / C / None), one variant per lead
  //   4. Additional Accessories → free multi-select over the rest of the
  //                               dealer's paraphernalia inventory.
  const digitalSoc = items.filter((p) => p.asset_type === "DigitalSOC");
  const voltSoc = items.filter((p) => p.asset_type === "VoltSOC");
  const harness = items.filter((p) => p.asset_type === "Harness");
  const additional = items.filter(
    (p) =>
      p.asset_type !== "DigitalSOC" &&
      p.asset_type !== "VoltSOC" &&
      p.asset_type !== "Harness",
  );

  return (
    <div className="space-y-5">
      {digitalSoc.length > 0 && (
        <ParaSubsection title="Digital SOC" hint="Count of digital SOC units. Validated against dealer stock.">
          {digitalSoc.map((p) => {
            const k = paraKey(p);
            return (
              <ParaItemRow
                key={k}
                item={p}
                qty={paraQty[k] || 0}
                onChange={(n) => onChangeQty(k, n, p.available_qty)}
                disabled={disabled}
              />
            );
          })}
        </ParaSubsection>
      )}

      {voltSoc.length > 0 && (
        <ParaSubsection title="Volt SOC" hint="Count of volt SOC units.">
          {voltSoc.map((p) => {
            const k = paraKey(p);
            return (
              <ParaItemRow
                key={k}
                item={p}
                qty={paraQty[k] || 0}
                onChange={(n) => onChangeQty(k, n, p.available_qty)}
                disabled={disabled}
              />
            );
          })}
        </ParaSubsection>
      )}

      {harness.length > 0 && (
        <ParaSubsection title="Harness Variant" hint="Pick one variant per lead.">
          <HarnessVariantPicker
            options={harness}
            paraQty={paraQty}
            onChangeQty={onChangeQty}
            disabled={disabled}
          />
        </ParaSubsection>
      )}

      {additional.length > 0 && (
        <ParaSubsection
          title="Additional Accessories"
          hint="Free multi-select — pick any other items from your paraphernalia stock."
        >
          <AdditionalAccessoriesPicker
            options={additional}
            paraQty={paraQty}
            onChangeQty={onChangeQty}
            disabled={disabled}
          />
        </ParaSubsection>
      )}
    </div>
  );
}

export function ParaSubsection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="px-1 mb-2">
        <div className="text-[11px] font-black text-gray-700 uppercase tracking-widest">
          {title}
        </div>
        {hint && <div className="text-[11px] text-gray-400 mt-0.5">{hint}</div>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

export function AdditionalAccessoriesPicker({
  options,
  paraQty,
  onChangeQty,
  disabled,
}: {
  options: ParaRow[];
  paraQty: Record<string, number>;
  onChangeQty: (k: string, n: number, max: number) => void;
  disabled?: boolean;
}) {
  // BRD §SECTION D — "Free multi-select. Other items from dealer's
  // paraphernalia inventory. Shown dynamically from backend."
  // An accessory is included when its qty > 0; toggling the checkbox
  // sets qty to 1 (or back to 0). Per-row stepper appears once selected.
  const selected = options.filter((o) => (paraQty[paraKey(o)] || 0) > 0);
  const unselected = options.filter((o) => (paraQty[paraKey(o)] || 0) <= 0);

  return (
    <div className="space-y-3">
      {unselected.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1">
          {unselected.map((o) => {
            const k = paraKey(o);
            const label =
              o.product_name || `${o.asset_type} ${o.model_type ?? ""}`.trim();
            const outOfStock = o.available_qty <= 0;
            return (
              <button
                key={k}
                type="button"
                disabled={disabled || outOfStock}
                onClick={() => onChangeQty(k, 1, o.available_qty)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 text-xs font-bold transition-colors ${
                  outOfStock
                    ? "border-gray-100 bg-gray-50 text-gray-300 cursor-not-allowed"
                    : "border-[#EBEBEB] bg-white text-gray-700 hover:border-[#0047AB] hover:text-[#0047AB]"
                }`}
              >
                <Plus className="w-3 h-3" /> {label}
                <span className="text-[10px] text-gray-400 font-medium">
                  ({o.available_qty})
                </span>
              </button>
            );
          })}
        </div>
      )}

      {selected.map((p) => {
        const k = paraKey(p);
        return (
          <ParaItemRow
            key={k}
            item={p}
            qty={paraQty[k] || 0}
            onChange={(n) => onChangeQty(k, n, p.available_qty)}
            disabled={disabled}
            removable
            onRemove={() => onChangeQty(k, 0, p.available_qty)}
          />
        );
      })}

      {selected.length === 0 && unselected.length === 0 && (
        <div className="text-[11px] text-gray-400 px-1">
          No additional accessories in stock.
        </div>
      )}
    </div>
  );
}

export function ParaItemRow({
  item,
  qty,
  onChange,
  disabled,
  removable,
  onRemove,
}: {
  item: ParaRow;
  qty: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  removable?: boolean;
  onRemove?: () => void;
}) {
  const unitGross = Number(item.unit_gross ?? item.unit_price ?? 0);
  const gstPct = Number(item.gst_percent ?? 0);
  const unitGst = Number(item.unit_gst_amount ?? 0);
  const unitNet = Number(item.unit_net ?? unitGross + unitGst);
  return (
    <div className="px-4 py-3 rounded-xl border border-gray-100 hover:border-gray-200 transition-colors bg-gray-50/40">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-white border border-gray-100 flex items-center justify-center flex-shrink-0">
            <Package className="w-4 h-4 text-gray-500" />
          </div>
          <div className="min-w-0">
            <div className="font-bold text-sm text-gray-900 truncate">
              {item.product_name || `${item.asset_type} ${item.model_type ?? ""}`.trim()}
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              Available: {item.available_qty}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <QuantityStepper
            value={qty}
            max={item.available_qty}
            onChange={onChange}
            disabled={disabled}
          />
          {removable && (
            <button
              type="button"
              onClick={onRemove}
              disabled={disabled}
              aria-label="Remove accessory"
              className="w-8 h-8 rounded-lg border-2 border-gray-100 bg-white text-gray-400 hover:border-red-200 hover:text-red-500 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-2.5 grid grid-cols-4 gap-2 text-[10px] font-medium">
        <div className="bg-white border border-gray-100 rounded-lg px-2 py-1.5">
          <div className="text-gray-400 uppercase tracking-wider">Gross</div>
          <div className="text-gray-900 font-bold tabular-nums">{inr(unitGross)}</div>
        </div>
        <div className="bg-white border border-gray-100 rounded-lg px-2 py-1.5">
          <div className="text-gray-400 uppercase tracking-wider">
            GST {formatGstPct(gstPct)}
          </div>
          <div className="text-gray-900 font-bold tabular-nums">{inr(unitGst)}</div>
        </div>
        <div className="bg-white border border-gray-100 rounded-lg px-2 py-1.5">
          <div className="text-gray-400 uppercase tracking-wider">Net / unit</div>
          <div className="text-gray-900 font-bold tabular-nums">{inr(unitNet)}</div>
        </div>
        <div className="bg-emerald-50 border border-emerald-100 rounded-lg px-2 py-1.5">
          <div className="text-emerald-600 uppercase tracking-wider">Line ×{qty}</div>
          <div className="text-emerald-800 font-bold tabular-nums">
            {inr(qty * unitNet)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function HarnessVariantPicker({
  options,
  paraQty,
  onChangeQty,
  disabled,
}: {
  options: ParaRow[];
  paraQty: Record<string, number>;
  onChangeQty: (k: string, n: number, max: number) => void;
  disabled?: boolean;
}) {
  // Pick whichever harness variant currently has qty > 0 (only one allowed).
  const active = options.find((o) => (paraQty[paraKey(o)] || 0) > 0) || null;
  const activeKey = active ? paraKey(active) : "";
  const activeQty = active ? paraQty[activeKey] || 0 : 0;
  const max = active?.available_qty ?? 0;

  const handleSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newKey = e.target.value;
    // Zero all other variants, set 1 on the chosen one.
    options.forEach((o) => {
      const k = paraKey(o);
      if (k === newKey) onChangeQty(k, 1, o.available_qty);
      else if ((paraQty[k] || 0) > 0) onChangeQty(k, 0, o.available_qty);
    });
  };

  const unitGross = active ? Number(active.unit_gross ?? active.unit_price ?? 0) : 0;
  const gstPct = active ? Number(active.gst_percent ?? 0) : 0;
  const unitGst = active ? Number(active.unit_gst_amount ?? 0) : 0;
  const unitNet = active ? Number(active.unit_net ?? unitGross + unitGst) : 0;

  return (
    <div className="px-4 py-3 rounded-xl border border-gray-100 bg-gray-50/40">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-white border border-gray-100 flex items-center justify-center flex-shrink-0">
            <Package className="w-4 h-4 text-gray-500" />
          </div>
          <div className="min-w-0">
            <div className="font-bold text-sm text-gray-900">Harness</div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              Pick one variant per lead.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={activeKey}
            onChange={handleSelect}
            disabled={disabled}
            className="h-10 px-3 rounded-xl bg-white border-2 border-gray-100 text-sm font-bold text-gray-900 outline-none focus:border-[#1D4ED8] disabled:bg-gray-50"
          >
            <option value="">None</option>
            {options.map((o) => {
              const k = paraKey(o);
              const label = o.product_name || `Harness ${o.model_type ?? ""}`.trim() || `Harness ${k}`;
              return (
                <option key={k} value={k} disabled={o.available_qty <= 0}>
                  {label} (avail {o.available_qty})
                </option>
              );
            })}
          </select>
          {active && (
            <QuantityStepper
              value={activeQty}
              max={max}
              onChange={(n) => onChangeQty(activeKey, n, max)}
              disabled={disabled}
            />
          )}
        </div>
      </div>
      {active && (
        <div className="mt-2.5 grid grid-cols-4 gap-2 text-[10px] font-medium">
          <div className="bg-white border border-gray-100 rounded-lg px-2 py-1.5">
            <div className="text-gray-400 uppercase tracking-wider">Gross</div>
            <div className="text-gray-900 font-bold tabular-nums">{inr(unitGross)}</div>
          </div>
          <div className="bg-white border border-gray-100 rounded-lg px-2 py-1.5">
            <div className="text-gray-400 uppercase tracking-wider">
              GST {formatGstPct(gstPct)}
            </div>
            <div className="text-gray-900 font-bold tabular-nums">{inr(unitGst)}</div>
          </div>
          <div className="bg-white border border-gray-100 rounded-lg px-2 py-1.5">
            <div className="text-gray-400 uppercase tracking-wider">Net / unit</div>
            <div className="text-gray-900 font-bold tabular-nums">{inr(unitNet)}</div>
          </div>
          <div className="bg-emerald-50 border border-emerald-100 rounded-lg px-2 py-1.5">
            <div className="text-emerald-600 uppercase tracking-wider">Line ×{activeQty}</div>
            <div className="text-emerald-800 font-bold tabular-nums">
              {inr(activeQty * unitNet)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function QuantityStepper({
  value,
  max,
  onChange,
  disabled,
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex items-center bg-white border-2 border-gray-100 rounded-xl overflow-hidden">
      <button
        onClick={() => onChange(value - 1)}
        disabled={disabled || value <= 0}
        className="w-9 h-9 flex items-center justify-center text-gray-600 hover:bg-gray-50 disabled:opacity-30 transition-colors"
        aria-label="Decrease quantity"
      >
        <Minus className="w-4 h-4" />
      </button>
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value || 0))}
        disabled={disabled}
        className="w-12 h-9 text-center text-sm font-bold text-gray-900 outline-none border-x border-gray-100 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <button
        onClick={() => onChange(value + 1)}
        disabled={disabled || value >= max}
        className="w-9 h-9 flex items-center justify-center text-gray-600 hover:bg-gray-50 disabled:opacity-30 transition-colors"
        aria-label="Increase quantity"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}
