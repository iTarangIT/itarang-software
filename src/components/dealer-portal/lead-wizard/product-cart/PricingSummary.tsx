"use client";

import { TrendingUp, Wallet } from "lucide-react";

import { inr, inrFormatter } from "./pricing";
import type { MarginMode } from "./types";

/**
 * The sticky pricing rail. Kept prop-driven and layout-free so each page can
 * place it wherever its grid puts the right-hand column — Step 4 and Step 5
 * arrange their columns differently.
 */

export function PriceLine({
  label,
  value,
  muted,
}: {
  label: string;
  value: number;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={muted ? "text-gray-400 font-medium text-xs" : "text-gray-500 font-medium"}>
        {label}
      </span>
      <span
        className={`tabular-nums ${muted ? "text-gray-500 font-bold text-xs" : "text-gray-900 font-bold"}`}
      >
        {inr(value)}
      </span>
    </div>
  );
}

export function PricingSummary({
  batteryPrice,
  chargerPrice,
  paraCost,
  grossSubtotal,
  gstSubtotal,
  netSubtotal,
  dealerMargin,
  dealerMarginGst,
  dealerMarginGstPct,
  marginMode,
  marginInput,
  marginPercentInput,
  onMarginChange,
  onMarginPercentChange,
  onMarginModeChange,
  finalPrice,
  inventoryNote,
  disabled,
}: {
  batteryPrice: number;
  chargerPrice: number;
  paraCost: number;
  grossSubtotal: number;
  gstSubtotal: number;
  netSubtotal: number;
  dealerMargin: number;
  dealerMarginGst: number;
  dealerMarginGstPct: number;
  marginMode: MarginMode;
  marginInput: string;
  marginPercentInput: string;
  onMarginChange: (raw: string) => void;
  onMarginPercentChange: (raw: string) => void;
  onMarginModeChange: (next: MarginMode) => void;
  finalPrice: number;
  inventoryNote: string;
  disabled?: boolean;
}) {
  return (
    <div className="bg-white rounded-[24px] border border-[#E9ECEF] shadow-[0_8px_30px_rgb(0,0,0,0.02)] overflow-hidden">
      <div className="px-6 pt-6 pb-3 flex items-center gap-3">
        <div className="w-[3px] h-6 bg-[#0047AB] rounded-full" />
        <h3 className="text-base font-black text-gray-900 tracking-tight">Pricing</h3>
      </div>
      <div className="px-6 pb-6 space-y-3">
        <PriceLine label="Battery (incl. GST)" value={batteryPrice} />
        <PriceLine label="Charger (incl. GST)" value={chargerPrice} />
        <PriceLine label="Paraphernalia (incl. GST)" value={paraCost} />

        <div className="pt-3 border-t border-gray-100 space-y-1.5">
          <PriceLine label="Gross subtotal" value={grossSubtotal} muted />
          <PriceLine label="GST subtotal" value={gstSubtotal} muted />
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-700 font-bold">Net subtotal</span>
            <span className="text-gray-900 font-black tabular-nums">
              {inrFormatter.format(netSubtotal)}
            </span>
          </div>
        </div>

        <div className="pt-3 border-t border-gray-100">
          <div className="flex items-center justify-between px-1">
            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest flex items-center gap-1.5">
              <TrendingUp className="w-3 h-3" /> Dealer Margin
            </label>
            <div className="inline-flex rounded-lg border border-[#EBEBEB] bg-gray-50 p-0.5">
              <button
                type="button"
                onClick={() => onMarginModeChange("rupees")}
                disabled={disabled}
                className={`px-2.5 py-1 text-[10px] font-black rounded-md transition-colors ${
                  marginMode === "rupees"
                    ? "bg-white text-[#0047AB] shadow-sm"
                    : "text-gray-400 hover:text-gray-600"
                } disabled:cursor-not-allowed`}
                aria-pressed={marginMode === "rupees"}
              >
                ₹
              </button>
              <button
                type="button"
                onClick={() => onMarginModeChange("percent")}
                disabled={disabled}
                className={`px-2.5 py-1 text-[10px] font-black rounded-md transition-colors ${
                  marginMode === "percent"
                    ? "bg-white text-[#0047AB] shadow-sm"
                    : "text-gray-400 hover:text-gray-600"
                } disabled:cursor-not-allowed`}
                aria-pressed={marginMode === "percent"}
              >
                %
              </button>
            </div>
          </div>
          <div className="mt-1.5 relative">
            {marginMode === "rupees" ? (
              <>
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-bold">
                  ₹
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={marginInput}
                  onChange={(e) => onMarginChange(e.target.value)}
                  disabled={disabled}
                  className="w-full h-11 pl-8 pr-4 bg-white border-2 border-[#EBEBEB] rounded-xl text-sm font-bold text-gray-900 outline-none focus:border-[#1D4ED8] focus:ring-4 focus:ring-blue-50/50 disabled:bg-gray-50 disabled:text-gray-400"
                  placeholder="0"
                />
              </>
            ) : (
              <>
                <input
                  type="text"
                  inputMode="decimal"
                  value={marginPercentInput}
                  onChange={(e) => onMarginPercentChange(e.target.value)}
                  disabled={disabled}
                  className="w-full h-11 pl-4 pr-10 bg-white border-2 border-[#EBEBEB] rounded-xl text-sm font-bold text-gray-900 outline-none focus:border-[#1D4ED8] focus:ring-4 focus:ring-blue-50/50 disabled:bg-gray-50 disabled:text-gray-400"
                  placeholder="0"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-bold">
                  %
                </span>
              </>
            )}
          </div>
          {marginMode === "percent" ? (
            <p className="text-[10px] text-gray-500 mt-1.5 px-1 tabular-nums">
              {marginPercentInput && parseFloat(marginPercentInput) > 0
                ? `${marginPercentInput}% of net subtotal = `
                : "% of net subtotal = "}
              <span className="font-bold text-gray-700">
                {inrFormatter.format(dealerMargin)}
              </span>
            </p>
          ) : (
            <p className="text-[10px] text-gray-400 mt-1.5 px-1">
              Your earnings on this sale (before GST)
            </p>
          )}
          {dealerMargin > 0 && (
            <div className="mt-2 px-1">
              <PriceLine label={`GST on margin (${dealerMarginGstPct}%)`} value={dealerMarginGst} muted />
            </div>
          )}
        </div>

        <div className="pt-4 mt-2 border-t-2 border-gray-100">
          <div className="flex items-center justify-between">
            <span className="text-xs font-black text-gray-500 uppercase tracking-widest">
              Final Price
            </span>
            <span className="text-2xl font-black text-[#0047AB] tabular-nums">
              {inr(finalPrice)}
            </span>
          </div>
          <p className="text-[10px] text-gray-400 mt-2 flex items-center gap-1.5">
            <Wallet className="w-3 h-3" /> {inventoryNote}
          </p>
        </div>

        {/* Compact margin breakdown stat — only shown in rupees mode (in
            percent mode the helper line above already shows this), and always
            measured against net subtotal so it agrees with the % input. */}
        {marginMode === "rupees" && dealerMargin > 0 && netSubtotal > 0 && (
          <div className="px-3 py-2 bg-emerald-50 border border-emerald-100 rounded-lg">
            <p className="text-[10px] text-emerald-700 font-bold">
              Margin = {((dealerMargin / netSubtotal) * 100).toFixed(1)}% of net subtotal (excl. GST)
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
