/**
 * The shape a quotation document is rendered from.
 *
 * This type is the contract between the four impure things that assemble a
 * quotation (the commercials row, the lead, the product masters, the configured
 * company block) and the one pure thing that draws it. `renderProformaHtml`
 * accepts a QuotationView and nothing else, so the template cannot reach past
 * what was deliberately put in front of it — the same discipline
 * src/lib/buyback/pdf/quotation-template.ts uses.
 *
 * Every money field is a NUMBER OF RUPEES, already rounded to paise by
 * computeTotals(). The template formats; it never calculates. That split is
 * what makes the totals testable against the reference document without
 * rendering anything.
 */

/** A GST rate that nobody has set is `null`, never 0 — see QuotationLineView. */
export type GstRate = number | null;

export interface QuotationLineView {
  /** 1-based position as printed in the `#` column. */
  index: number;
  /** "Item & Description" — model name, with the model id under it when it adds anything. */
  description: string;
  /** Second line under the description, e.g. "(Non-IOT)". Omitted when empty. */
  descriptionNote: string | null;
  hsnCode: string | null;
  quantity: number;
  /** "pcs" for goods; a subscription line prints no unit, as ITPI-35 does. */
  unit: string | null;
  /** Per-unit price before tax. */
  rate: number;
  /** quantity x rate, before tax. */
  amount: number;
  /**
   * NULL means the catalogue has no rate for this model — NOT that the line is
   * zero-rated. The two are different claims and only one of them is ours to
   * make, so the template prints an explicit marker and `QuotationView.hasUnsetTax`
   * goes true. E-242 ships these columns empty on purpose.
   */
  gstRatePct: GstRate;
  /** NULL exactly when gstRatePct is NULL. */
  gstAmount: number | null;
}

/**
 * One row in the totals block, e.g. `GST18 (18%)` or `CGST9 (9%)`.
 *
 * The label carries the rate twice, matching ITPI-35 — the register name
 * (`GST18`) and the rate as applied (`(18%)`) — because a document showing two
 * different rates needs both to be unambiguous about which lines fed which row.
 *
 * The inter-state row is labelled GST rather than IGST — see computeTotals.
 */
export interface TaxRow {
  label: string;
  amount: number;
}

export interface SellerBlock {
  legalName: string;
  addressLines: string[];
  gstin: string | null;
  email: string | null;
  website: string | null;
  /** State the goods ship FROM. Decides IGST vs CGST+SGST. */
  stateCode: string;
  stateName: string;
  /**
   * The letterhead mark, as a `data:` URI — never a path or an https URL.
   *
   * renderPdfFromHtml calls setContent() with no base URL and waits only for
   * domcontentloaded, so anything the browser would have to FETCH renders as a
   * broken image, silently, on a document that has already gone to a dealer.
   * NULL prints no image at all, which is the honest degradation.
   */
  logoDataUri: string | null;
}

export interface BillToBlock {
  name: string;
  gstin: string | null;
  addressLines: string[];
  /**
   * The lead's mobile number, printed under the address.
   *
   * On the document because a quotation gets worked from the printed page as
   * often as from the CRM, and whoever is chasing it should not have to look
   * the dealer up to ring them. NULL prints no line at all rather than a
   * dangling "Mobile" label.
   */
  phone: string | null;
}

export interface BankBlock {
  bank: string | null;
  accountName: string | null;
  accountNo: string | null;
  ifsc: string | null;
  branch: string | null;
}

/**
 * What the rep agreed with THIS dealer, as opposed to `QuotationView.terms`,
 * which is iTarang's standing small print and is the same on every document.
 *
 * Free text, printed as entered. `credit_terms` says "120" on one quote and
 * "120 days" on the next because the field takes whatever the rep types; the
 * document must not pretend to a precision the data does not have, so nothing
 * here is parsed or unit-suffixed.
 *
 * Every field is nullable and a null one prints no row. A quote raised before
 * this existed therefore renders exactly as it did.
 */
export interface CommercialTerms {
  paymentMethod: string | null;
  creditTerms: string | null;
  deliveryTerms: string | null;
  warranty: string | null;
  /**
   * INTERNAL FIELD, PRINTED TO THE DEALER by explicit decision. The modal that
   * captures it says so, because the only thing that stops an internal remark
   * reaching a dealer is the author knowing where it goes.
   */
  dealNotes: string | null;
}

export interface QuotationView {
  /** "Proforma Invoice" — configurable, because the business owns what it calls this. */
  documentTitle: string;
  quoteNumber: string;
  /** dd/MM/yyyy, IST. Preformatted: the template does no date maths. */
  quoteDate: string;
  /** "Uttarakhand (05)". NULL when the lead has no resolvable state. */
  placeOfSupply: string | null;

  seller: SellerBlock;
  billTo: BillToBlock;

  lines: QuotationLineView[];

  subTotal: number;
  taxRows: TaxRow[];
  total: number;
  totalInWords: string;

  /**
   * True when any line's gstRatePct is NULL. The template shows a banner, and
   * the sales manager is told before the document reaches a dealer rather than
   * after — a tax document that silently under-totals is worse than one that
   * says it is incomplete.
   */
  hasUnsetTax: boolean;
  /** True when the tax is CGST+SGST rather than IGST — intra-state supply. */
  isIntraState: boolean;

  /** This deal's terms. Distinct from `terms` below, which is the small print. */
  commercialTerms: CommercialTerms;

  signatory: string | null;
  /**
   * The scanned signature block, as a data: URI. It already carries the company
   * line and the signatory's title, so the template drops its own rule and
   * "Authorized Signature" caption when this is present — a document with two
   * titles for one signatory reads as a mistake.
   */
  signatureDataUri: string | null;
  notes: string[];
  bank: BankBlock;
  terms: string[];
}
