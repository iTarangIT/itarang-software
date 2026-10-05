/**
 * Turning a quote into the thing the template draws.
 *
 * PURE — takes already-fetched facts and returns a QuotationView. The two
 * lookups it needs (product-master tax refs, and the dealer's state) live in
 * ./view-store, so the mapping — which is where the interesting decisions are:
 * what an unpriced line does, how a description is composed, what happens when
 * a lead has no state — is testable without a database.
 */
import { printedListPrice } from "../listPricing";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { amountInWords } from "./amount-in-words";
import type { QuotationDocConfig } from "./config";
import { computeTotals, lineGstAmount, toPaise } from "./tax";
import type { CommercialTerms, QuotationLineView, QuotationView } from "./types";

/** HSN + GST rate for one product, as held on its master row. */
export interface LineTaxRef {
  hsnCode: string | null;
  gstRatePct: number | null;
}

/** Key for the tax-ref map — matches oemPricing's refKey shape. */
export function taxRefKey(assetType: string, productId: string): string {
  return `${assetType}:${productId}`;
}

/**
 * Business-fixed GST policy per asset type, decided 2026-08-20: battery 18%,
 * charger 5%, paraphernalia 18% — the same rates the loan calculator encodes
 * (calculator/config-resolver.ts). These are policy, not guesses, which is why
 * they may appear on a tax document; a rate set on the product-master row still
 * wins, so a product taxed differently is a catalogue edit, not a code change.
 * E-256 backfills the masters with the same values; this fallback keeps the
 * document right on a database the migration hasn't reached.
 */
export const DEFAULT_TAX_BY_ASSET_TYPE: Record<
  string,
  { gstRatePct: number; hsnCode: string }
> = {
  battery: { gstRatePct: 18, hsnCode: "85076000" },
  charger: { gstRatePct: 5, hsnCode: "85044030" },
  paraphernalia: { gstRatePct: 18, hsnCode: "85079090" },
};

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
  /**
   * E-323 — the list price per product, keyed like taxRefs: the admin list
   * price, else the OEM price. Absent (older quotes, every existing test) = no
   * List price / Discount columns at all.
   */
  listRefs?: Map<string, number>;
  placeOfSupply: PlaceOfSupply;
  dealer: {
    name: string | null;
    gstin: string | null;
    addressLines?: string[];
    /** The lead's mobile number, printed in the Bill To block. */
    phone?: string | null;
  };
  /**
   * The deal's own terms, straight off the commercials row. Optional so a
   * caller that has none — and every existing test — still compiles; absent
   * behaves the same as all-null, which prints no terms block.
   */
  commercialTerms?: Partial<CommercialTerms>;
}

/**
 * The lead's address, as the two lines a Bill To block prints.
 *
 * PURE and exported so the composition is testable without a database — the
 * lead's address is spread over five free-text columns (`location`, `area`,
 * `city`, `state`, `pincode`), any of which may be blank, duplicated, or hold
 * the same town under two spellings.
 *
 * DE-DUPLICATED case-insensitively, because `location` is very often just the
 * city again: printing "Panipat" twice on a dealer's own quotation reads as a
 * mistake in the CRM, which is exactly what it is. Nothing is invented — a lead
 * with no address prints no address lines at all rather than a row of commas.
 */
export function composeBillToAddress(a: {
  location?: string | null;
  area?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
}): string[] {
  const seen = new Set<string>();
  const take = (v: string | null | undefined): string | null => {
    const s = (v ?? "").trim();
    if (!s) return null;
    const key = s.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    return s;
  };

  // CLAIMED IN THE OPPOSITE ORDER TO THE ORDER THEY PRINT. The structured
  // columns (city, state) claim their names first, so when `location` is just
  // the city again it is the free-text copy that gets dropped — otherwise
  // "panipat" would hold the name and the properly-cased "Panipat" would be the
  // one suppressed, moving the city out of the line it belongs on.
  const region = [take(a.city), take(a.state)].filter(Boolean) as string[];
  const street = [take(a.area), take(a.location)].filter(Boolean) as string[];
  const pin = (a.pincode ?? "").trim();

  const lines: string[] = [];
  if (street.length) lines.push(street.join(", "));
  // The PIN joins its own line with a space, not a comma: "Panipat, Haryana
  // 132103". A PIN with no city or state still earns the line — it is the one
  // part of an address that is unambiguous on its own.
  const tail = [region.join(", "), pin].filter(Boolean).join(" ");
  if (tail) lines.push(tail);
  return lines;
}

/**
 * Blank-to-null, so " " and "" are the same as never-entered.
 *
 * The document draws a row per non-null term, and a row reading "Warranty: "
 * looks like a term that was agreed and then lost rather than one that was
 * never set.
 */
function term(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
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
    const fallback = DEFAULT_TAX_BY_ASSET_TYPE[l.asset_type];
    const rate = l.unit_price == null ? 0 : Number(l.unit_price);
    const quantity = Number(l.quantity) || 0;
    const amount = toPaise((Number.isFinite(rate) ? rate : 0) * quantity);
    const gstRatePct = ref?.gstRatePct ?? fallback?.gstRatePct ?? null;
<<<<<<< HEAD
    // Discount = list − net, per unit, before GST. GST stays on the net price.
    const list = input.listRefs
      ? printedListPrice({
          listPrice: input.listRefs.get(taxRefKey(l.asset_type, l.product_id)),
          oemPrice: null,
          netPrice: Number.isFinite(rate) ? rate : 0,
        })
      : null;
=======
    const netRate = Number.isFinite(rate) ? rate : 0;

    // E-321 — the snapshotted list price, and the discount down to the quoted
    // rate, both before GST. A discount only when the list price is genuinely
    // above the rate; an unpriced line (rate 0 because none was entered) gets
    // none, since "discounted to nothing" is not what the rep said.
    const rawList = l.list_price == null ? null : Number(l.list_price);
    const listPrice = rawList != null && Number.isFinite(rawList) ? rawList : null;
    const discount =
      listPrice != null && l.unit_price != null && listPrice > netRate
        ? toPaise((listPrice - netRate) * quantity)
        : 0;
>>>>>>> fac2a80905456e04c4d89ee14f26fdf80ae34f9e

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
      hsnCode: ref?.hsnCode ?? fallback?.hsnCode ?? null,
      quantity,
      // Paraphernalia is counted, not measured; the reference document prints
      // "pcs" on goods lines and nothing on the subscription line.
      unit: l.asset_type === "paraphernalia" ? null : "pcs",
<<<<<<< HEAD
      rate: Number.isFinite(rate) ? rate : 0,
      listPrice: list?.listPrice ?? null,
      discount: list?.discount ?? null,
=======
      rate: netRate,
      listPrice,
      discount,
>>>>>>> fac2a80905456e04c4d89ee14f26fdf80ae34f9e
      amount,
      gstRatePct,
      gstAmount: lineGstAmount(amount, gstRatePct),
    };
  });

  const totalDiscount = toPaise(
    lineViews.reduce((sum, l) => sum + (l.discount ?? 0) * l.quantity, 0),
  );

  const totals = computeTotals({
    lines: lineViews,
    sellerStateCode: config.seller.stateCode,
    placeOfSupplyStateCode: placeOfSupply.stateCode,
  });

  const totalDiscount = toPaise(lineViews.reduce((s, l) => s + l.discount, 0));

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
      phone: (dealer.phone ?? "").trim() || null,
    },
    lines: lineViews,
    // The List price / Discount columns print only when a discount is being
    // given — a quote at list price reads exactly as it did before.
    showListPrice: totalDiscount > 0,
    totalDiscount,
    subTotal: totals.subTotal,
    totalDiscount,
    hasDiscount: totalDiscount > 0,
    taxRows: totals.taxRows,
    total: totals.total,
    totalInWords: amountInWords(totals.total),
    hasUnsetTax: totals.hasUnsetTax,
    isIntraState: totals.isIntraState,
    commercialTerms: {
      paymentMethod: term(input.commercialTerms?.paymentMethod),
      creditTerms: term(input.commercialTerms?.creditTerms),
      deliveryTerms: term(input.commercialTerms?.deliveryTerms),
      warranty: term(input.commercialTerms?.warranty),
      dealNotes: term(input.commercialTerms?.dealNotes),
    },
    signatory: config.signatory,
    signatureDataUri: config.signatureDataUri,
    notes: config.notes,
    bank: config.bank,
    terms: config.terms,
  };
}
