"use client";

import { Battery as BatteryIcon, Sparkles } from "lucide-react";

import { AgeBadge, SocBar } from "./list-chrome";
import { formatGstPct, formatShortDate, inr } from "./pricing";
import type { BatteryRow, ChargerRow } from "./types";

/** The selectable battery / charger tiles and their price breakdown chrome. */

export function SpecChips({
  voltage,
  capacity,
  warrantyMonths,
  status,
}: {
  voltage?: number | null;
  capacity?: number | null;
  warrantyMonths?: number | null;
  status?: string | null;
}) {
  const chips: string[] = [];
  if (voltage) chips.push(`${voltage}V`);
  if (capacity) chips.push(`${capacity}AH`);
  if (warrantyMonths && warrantyMonths > 0) {
    const years = warrantyMonths / 12;
    chips.push(
      Number.isInteger(years) ? `${years} yr warranty` : `${warrantyMonths} mo warranty`,
    );
  }
  const norm = (status ?? "").toLowerCase();
  const statusChip =
    norm === "available"
      ? { label: "Available", tone: "emerald" as const }
      : norm === "reserved"
        ? { label: "Reserved", tone: "amber" as const }
        : norm
          ? { label: status as string, tone: "gray" as const }
          : null;
  if (chips.length === 0 && !statusChip) return null;
  const toneClass: Record<string, string> = {
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-100",
    amber: "bg-amber-50 text-amber-700 border-amber-100",
    gray: "bg-gray-50 text-gray-600 border-gray-100",
  };
  return (
    <div className="mt-2 flex items-center gap-1.5 flex-wrap">
      {chips.map((c) => (
        <span
          key={c}
          className="px-2 py-0.5 rounded-md bg-gray-50 border border-gray-100 text-[10px] font-bold text-gray-700 tracking-wide"
        >
          {c}
        </span>
      ))}
      {statusChip && (
        <span
          className={`px-2 py-0.5 rounded-md border text-[10px] font-bold tracking-wide ${toneClass[statusChip.tone]}`}
        >
          {statusChip.label}
        </span>
      )}
    </div>
  );
}

export function GstLine({
  gross,
  gstPercent,
  gstAmount,
  net,
}: {
  gross?: string | number | null;
  gstPercent?: string | number | null;
  gstAmount?: string | number | null;
  net?: string | number | null;
}) {
  const grossN = Number(gross ?? 0);
  const gstAmtN = Number(gstAmount ?? 0);
  const netN = Number(net ?? 0);
  if (grossN <= 0 && netN <= 0) return null;
  return (
    <div className="mt-3 grid grid-cols-3 gap-2 text-[10px] font-medium">
      <div className="bg-gray-50 border border-gray-100 rounded-lg px-2 py-1.5">
        <div className="text-gray-400 uppercase tracking-wider">Gross</div>
        <div className="text-gray-900 font-bold tabular-nums">{inr(grossN)}</div>
      </div>
      <div className="bg-gray-50 border border-gray-100 rounded-lg px-2 py-1.5">
        <div className="text-gray-400 uppercase tracking-wider">
          GST {formatGstPct(gstPercent)}
        </div>
        <div className="text-gray-900 font-bold tabular-nums">{inr(gstAmtN)}</div>
      </div>
      <div className="bg-emerald-50 border border-emerald-100 rounded-lg px-2 py-1.5">
        <div className="text-emerald-600 uppercase tracking-wider">Net</div>
        <div className="text-emerald-800 font-bold tabular-nums">
          {inr(netN || grossN + gstAmtN)}
        </div>
      </div>
    </div>
  );
}

export function SelectedBatterySummary({
  battery,
  price,
}: {
  battery: BatteryRow;
  price: number;
}) {
  const specs: { label: string; value: string }[] = [];
  if (battery.voltage_v) specs.push({ label: "Voltage", value: `${battery.voltage_v}V` });
  if (battery.capacity_ah) specs.push({ label: "Capacity", value: `${battery.capacity_ah}Ah` });
  if (battery.warranty_months) specs.push({ label: "Warranty", value: `${battery.warranty_months} mo` });
  if (battery.soc_percent != null) specs.push({ label: "SoC", value: `${battery.soc_percent}%` });
  return (
    <div className="rounded-2xl border-2 border-[#0047AB]/20 bg-gradient-to-r from-blue-50 to-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-[#0047AB] text-white flex items-center justify-center flex-shrink-0">
            <BatteryIcon className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-black text-[#0047AB] uppercase tracking-widest">Selected Battery</p>
            <p className="text-sm font-black text-gray-900 truncate">
              {battery.model_name || battery.model_type || "Battery"}
            </p>
            <p className="text-[11px] text-gray-500 font-mono truncate">{battery.serial_number}</p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-black text-[#0047AB]">{inr(price)}</div>
          <div className="text-[10px] text-gray-400 font-medium">incl. GST</div>
        </div>
      </div>
      {specs.length > 0 && (
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {specs.map((s) => (
            <span
              key={s.label}
              className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-[#0047AB]/15 rounded-full text-[11px] font-bold text-gray-700"
            >
              <span className="text-gray-400">{s.label}:</span> {s.value}
            </span>
          ))}
          <AgeBadge badge={battery.age_badge} days={battery.inventory_age_days} />
        </div>
      )}
    </div>
  );
}

export function BatteryCard({
  battery,
  selected,
  onSelect,
  disabled,
}: {
  battery: BatteryRow;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const ageBorder = selected
    ? "border-[#0047AB] bg-blue-50/50 ring-4 ring-blue-100"
    : battery.age_badge === "old"
      ? "border-red-200 hover:border-red-400"
      : battery.age_badge === "ageing"
        ? "border-amber-200 hover:border-amber-400"
        : "border-gray-100 hover:border-gray-300";
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      aria-disabled={disabled}
      className={`relative text-left p-4 rounded-2xl border-2 transition-all bg-white shadow-sm hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 ${ageBorder}`}
    >
      {battery.recommended && (
        <span className="absolute -top-2 -right-2 inline-flex items-center gap-1 px-2.5 py-0.5 bg-emerald-500 text-white rounded-full text-[10px] font-black uppercase tracking-wider shadow-sm">
          <Sparkles className="w-3 h-3" /> Recommended
        </span>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-black text-gray-900 font-mono tracking-tight truncate">
            {battery.serial_number}
          </div>
          <div className="text-[11px] text-gray-500 mt-1 font-medium truncate">
            {battery.model_name || battery.model_type || "Battery"}
          </div>
          <SpecChips
            voltage={battery.voltage_v}
            capacity={battery.capacity_ah}
            warrantyMonths={battery.warranty_months}
            status={battery.status}
          />
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-base font-black text-[#0047AB]">
            {inr(Number(battery.net_amount ?? battery.price ?? 0))}
          </div>
          <div className="text-[10px] text-gray-400 font-medium">incl. GST</div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <AgeBadge badge={battery.age_badge} days={battery.inventory_age_days} />
        {battery.invoice_date && (
          <span className="text-[10px] text-gray-500 font-medium">
            Invoiced {formatShortDate(battery.invoice_date)}
          </span>
        )}
      </div>
      <div className="mt-3">
        <SocBar
          socPercent={battery.soc_percent}
          lastSyncAt={battery.soc_last_sync_at}
        />
      </div>
      <GstLine
        gross={battery.gross_amount}
        gstPercent={battery.gst_percent}
        gstAmount={battery.gst_amount}
        net={battery.net_amount}
      />
    </button>
  );
}

export function ChargerCard({
  charger,
  selected,
  onSelect,
  disabled,
}: {
  charger: ChargerRow;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const border = selected
    ? "border-[#0047AB] bg-blue-50/50 ring-4 ring-blue-100"
    : "border-gray-100 hover:border-gray-300";
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      aria-disabled={disabled}
      className={`relative text-left p-4 rounded-2xl border-2 transition-all bg-white shadow-sm hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 ${border}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-black text-gray-900 font-mono tracking-tight truncate">
            {charger.serial_number}
          </div>
          <div className="text-[11px] text-gray-500 mt-1 font-medium truncate">
            {charger.model_name || charger.model_type || "Charger"}
          </div>
          <SpecChips
            warrantyMonths={charger.warranty_months}
            status={charger.status}
          />
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-base font-black text-[#0047AB]">
            {inr(Number(charger.net_amount ?? charger.price ?? 0))}
          </div>
          <div className="text-[10px] text-gray-400 font-medium">incl. GST</div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <AgeBadge badge={charger.age_badge} days={charger.inventory_age_days} />
        {charger.invoice_date && (
          <span className="text-[10px] text-gray-500 font-medium">
            Invoiced {formatShortDate(charger.invoice_date)}
          </span>
        )}
      </div>
      <GstLine
        gross={charger.gross_amount}
        gstPercent={charger.gst_percent}
        gstAmount={charger.gst_amount}
        net={charger.net_amount}
      />
    </button>
  );
}
