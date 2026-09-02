import type {
  BatteryRow,
  CartTotals,
  ChargerRow,
  MarginMode,
  ParaLine,
  ParaRow,
  PriceTriple,
  PriorSelection,
} from "./types";

/**
 * Cart pricing math, extracted from the Step-4 page's useMemo block.
 *
 * Deliberately pure and React-free: there was never any state in that block,
 * only derivations over the current selection. Keeping it as plain functions
 * means the hook can memoise it once and any server-side or admin surface can
 * reuse the same arithmetic instead of re-deriving it.
 */

export const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

export const inr = (n: number) => inrFormatter.format(Number.isFinite(n) ? n : 0);

/** Classify a product option by its inventory asset_type. */
export function productClass(
  assetType: string | null | undefined,
): "battery" | "charger" | "paraphernalia" {
  const t = (assetType ?? "").trim().toLowerCase();
  if (t === "battery") return "battery";
  if (t === "charger") return "charger";
  return "paraphernalia";
}

/** Normalise a SKU / type string for tolerant comparison. */
export function normKey(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

export function paraKey(p: ParaRow): string {
  return `${p.asset_type}|${p.model_type || ""}`;
}

// Returns the per-line { gross, gst%, gst, net } for a battery or charger row.
// Falls back to legacy `price` (treated as net) when GST snapshot is absent.
export function triple(
  row:
    | {
        price?: number | null;
        gross_amount?: string | number | null;
        gst_percent?: string | number | null;
        gst_amount?: string | number | null;
        net_amount?: string | number | null;
      }
    | null,
): PriceTriple {
  if (!row) return { gross: 0, gstPct: 0, gst: 0, net: 0 };
  const gross = Number(row.gross_amount ?? 0);
  const gstPct = Number(row.gst_percent ?? 0);
  const gstAmt = Number(row.gst_amount ?? 0);
  const net = Number(row.net_amount ?? 0);
  if (gross > 0 || net > 0) {
    return { gross, gstPct, gst: gstAmt, net: net || gross + gstAmt };
  }
  // Legacy fallback: treat `price` as net, infer no GST split.
  const fallback = Number(row.price ?? 0);
  return { gross: fallback, gstPct: 0, gst: 0, net: fallback };
}

export function formatGstPct(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n === 0) return "0%";
  return `${Number.isInteger(n) ? n : n.toFixed(2)}%`;
}

export function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatLastSaved(d: Date): string {
  const time = d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  return `Auto-saved at ${time}`;
}

/** Expand the paraphernalia quantity map into priced lines. */
export function buildParaLines(
  items: ParaRow[],
  qtyByKey: Record<string, number>,
): ParaLine[] {
  return items
    .map((p) => {
      const qty = qtyByKey[paraKey(p)] || 0;
      const unitGross = Number(p.unit_gross ?? p.unit_price ?? 0);
      const gstPct = Number(p.gst_percent ?? 0);
      const unitGstAmt =
        Number(p.unit_gst_amount) || Math.round((unitGross * gstPct) / 100);
      const unitNet = Number(p.unit_net) || unitGross + unitGstAmt;
      return {
        asset_type: p.asset_type,
        model_type: p.model_type,
        product_name: p.product_name,
        product_id: p.product_id ?? null,
        qty,
        unit_gross: unitGross,
        gst_percent: gstPct,
        gst_amount: unitGstAmt,
        unit_net: unitNet,
        line_gross: qty * unitGross,
        line_gst: qty * unitGstAmt,
        line_net: qty * unitNet,
      };
    })
    .filter((l) => l.qty > 0);
}

/**
 * Effective margin in rupees. In percent mode it is a live function of
 * netSubtotal, so changing the cart auto-updates the margin amount.
 */
export function resolveMargin(
  mode: MarginMode,
  rupees: string,
  percent: string,
  netSubtotal: number,
): number {
  if (mode === "percent") {
    const p = parseFloat(percent);
    if (!Number.isFinite(p) || p < 0) return 0;
    return Math.round((netSubtotal * p) / 100);
  }
  const r = parseFloat(rupees);
  return Number.isFinite(r) && r >= 0 ? r : 0;
}

/**
 * GST charged on the dealer's margin. Policy: every rupee a dealer adds on top
 * of the GST-inclusive item total is itself a taxable supply, so the customer
 * pays margin + 18% of margin.
 *
 *   marginGst  = round(margin × 18 / 100)
 *   finalPrice = netSubtotal + margin + marginGst
 *
 * e.g. items ₹10,000 · margin 5% = ₹500 · GST ₹90 → final ₹10,590.
 */
export const MARGIN_GST_PCT = 18;

/** GST on the dealer margin, whole rupees. 0 for a zero / invalid margin. */
export function marginGst(margin: number, pct: number = MARGIN_GST_PCT): number {
  const m = Number(margin);
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.round((m * pct) / 100);
}

/** The one definition of the customer-facing total. */
export function finalPriceOf(
  netSubtotal: number,
  margin: number,
  gst: number = marginGst(margin),
): number {
  return Number(netSubtotal || 0) + Number(margin || 0) + Number(gst || 0);
}

export function computeTotals(input: {
  battery: BatteryRow | null;
  charger: ChargerRow | null;
  paraphernalia: ParaRow[];
  paraQty: Record<string, number>;
  marginMode: MarginMode;
  marginInput: string;
  marginPercentInput: string;
}): CartTotals {
  const batteryTriple = triple(input.battery);
  const chargerTriple = triple(input.charger);
  const paraLines = buildParaLines(input.paraphernalia, input.paraQty);

  const paraCost = paraLines.reduce((s, l) => s + l.line_net, 0);
  const paraGross = paraLines.reduce((s, l) => s + l.line_gross, 0);
  const paraGst = paraLines.reduce((s, l) => s + l.line_gst, 0);

  const grossSubtotal = batteryTriple.gross + chargerTriple.gross + paraGross;
  const gstSubtotal = batteryTriple.gst + chargerTriple.gst + paraGst;
  const netSubtotal = batteryTriple.net + chargerTriple.net + paraCost;

  const dealerMargin = resolveMargin(
    input.marginMode,
    input.marginInput,
    input.marginPercentInput,
    netSubtotal,
  );

  return {
    batteryTriple,
    chargerTriple,
    batteryPrice: batteryTriple.net,
    chargerPrice: chargerTriple.net,
    paraLines,
    paraCost,
    paraGross,
    paraGst,
    grossSubtotal,
    gstSubtotal,
    netSubtotal,
    dealerMargin,
    dealerMarginGstPct: MARGIN_GST_PCT,
    dealerMarginGst: marginGst(dealerMargin),
    finalPrice: finalPriceOf(netSubtotal, dealerMargin),
  };
}

const toNum = (v: string | null | undefined): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * Pricing read back from the submitted snapshot.
 *
 * Once a serial is reserved it drops out of the available-inventory list, so
 * the cart can no longer rehydrate and the live math collapses to zero. Falling
 * back to what was actually submitted keeps the Pricing card honest.
 */
export function totalsFromPrior(prior: PriorSelection): CartTotals {
  const batteryTriple: PriceTriple = {
    gross: toNum(prior.battery_gross),
    gstPct: toNum(prior.battery_gst_percent),
    gst: toNum(prior.battery_gst_amount),
    net: toNum(prior.battery_net ?? prior.battery_price),
  };
  const chargerTriple: PriceTriple = {
    gross: toNum(prior.charger_gross),
    gstPct: toNum(prior.charger_gst_percent),
    gst: toNum(prior.charger_gst_amount),
    net: toNum(prior.charger_net ?? prior.charger_price),
  };
  const paraLines = Array.isArray(prior.paraphernalia_lines)
    ? (prior.paraphernalia_lines as ParaLine[])
    : [];
  const paraCost = toNum(prior.paraphernalia_cost);

  return {
    batteryTriple,
    chargerTriple,
    batteryPrice: batteryTriple.net,
    chargerPrice: chargerTriple.net,
    paraLines,
    paraCost,
    paraGross: paraLines.reduce((s, l) => s + (l.line_gross || 0), 0),
    paraGst: paraLines.reduce((s, l) => s + (l.line_gst || 0), 0),
    grossSubtotal: toNum(prior.gross_subtotal),
    gstSubtotal: toNum(prior.gst_subtotal),
    netSubtotal: toNum(prior.net_subtotal),
    dealerMargin: toNum(prior.dealer_margin),
    // Rows written before E-273 carry no margin GST (NULL → 0). The stored
    // final_price is what the customer approved, so it is never recomputed.
    dealerMarginGstPct: toNum(prior.dealer_margin_gst_percent),
    dealerMarginGst: toNum(prior.dealer_margin_gst_amount),
    finalPrice: toNum(prior.final_price),
  };
}
