/**
 * Turning a quote into the thing the template draws.
 *
 * PURE — takes already-fetched facts and returns a QuotationView. The two
 * lookups it needs (product-master tax refs, and the dealer's state) live in
 * ./view-store, so the mapping — which is where the interesting decisions are:
 * what an unpriced line does, how a description is composed, what happens when
 * a lead has no state — is testable without a database.
 */
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { amountInWords } from "./amount-in-words";
import type { QuotationDocConfig } from "./config";
import { computeTotals, lineGstAmount, toPaise } from "./tax";
import type { QuotationLineView, QuotationView } from "./types";

/** HSN + GST rate for one product, as held on its master row. */
export interface LineTaxRef {
  hsnCode: string | null;
  gstRatePct: number | null;
}

/** Key for the tax-ref map — matches oemPricing's refKey shape. */
export function taxRefKey(assetType: string, productId: string): string {
  return `${assetType}:${productId}`;
}

export interface PlaceOfSupply {
  stateCode: string | null;
  /** "Uttarakhand (05)" — already formatted for the document. */
  label: string | null;
}

/** dd/MM/yyyy in IST, matching the reference document's Quote Date. */
export function formatQuoteDate(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(d);
}

export interface BuildQuotationViewInput {
  quoteNumber: string;
  quoteDate: Date;
  config: QuotationDocConfig;
  lines: CommercialsProductLine[];
  taxRefs: Map<string, LineTaxRef>;
  placeOfSupply: PlaceOfSupply;
  dealer: {
    name: string | null;
    gstin: string | null;
    addressLines?: string[];
  };
}

/**
 * PURE. Everything the document says, decided here.
 *
 * A line with no unit_price contributes 0 to the total rather than being
 * dropped: the rep put it on the quote, so it belongs on the document, and a
 * silently missing line is how a dealer receives a quotation for fewer things
 * than were agreed.
 */
export function buildQuotationView(input: BuildQuotationViewInput): QuotationView {
  const { config, lines, taxRefs, placeOfSupply, dealer } = input;

  const lineViews: QuotationLineView[] = lines.map((l, i) => {
    const ref = taxRefs.get(taxRefKey(l.asset_type, l.product_id));
    const rate = l.unit_price == null ? 0 : Number(l.unit_price);
    const quantity = Number(l.quantity) || 0;
    const amount = toPaise((Number.isFinite(rate) ? rate : 0) * quantity);
    const gstRatePct = ref?.gstRatePct ?? null;

    // The model id earns its place under the name only when it says something
    // the name does not already contain.
    const name = (l.product_name ?? "").trim();
    const modelId = (l.model_id ?? "").trim();
    const note =
      modelId && !name.toLowerCase().includes(modelId.toLowerCase())
        ? `Model: ${modelId}`
        : null;

    return {
      index: i + 1,
      description: name || modelId || "(unnamed item)",
      descriptionNote: note,
      hsnCode: ref?.hsnCode ?? null,
      quantity,
      // Paraphernalia is counted, not measured; the reference document prints
      // "pcs" on goods lines and nothing on the subscription line.
      unit: l.asset_type === "paraphernalia" ? null : "pcs",
      rate: Number.isFinite(rate) ? rate : 0,
      amount,
      gstRatePct,
      gstAmount: lineGstAmount(amount, gstRatePct),
    };
  });

  const totals = computeTotals({
    lines: lineViews,
    sellerStateCode: config.seller.stateCode,
    placeOfSupplyStateCode: placeOfSupply.stateCode,
  });

  return {
    documentTitle: config.documentTitle,
    quoteNumber: input.quoteNumber,
    quoteDate: formatQuoteDate(input.quoteDate),
    placeOfSupply: placeOfSupply.label,
    seller: config.seller,
    billTo: {
      name: (dealer.name ?? "").trim() || "(dealer name not recorded)",
      gstin: dealer.gstin,
      addressLines: dealer.addressLines ?? [],
    },
    lines: lineViews,
    subTotal: totals.subTotal,
    taxRows: totals.taxRows,
    total: totals.total,
    totalInWords: amountInWords(totals.total),
    hasUnsetTax: totals.hasUnsetTax,
    isIntraState: totals.isIntraState,
    signatory: config.signatory,
    notes: config.notes,
    bank: config.bank,
    terms: config.terms,
  };
}
