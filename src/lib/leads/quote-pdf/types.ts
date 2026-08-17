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
 * One row in the totals block, e.g. `IGST18 (18%)` or `CGST9 (9%)`.
 *
 * The label carries the rate twice, matching ITPI-35 — the register name
 * (`IGST18`) and the rate as applied (`(18%)`) — because a document showing two
 * different rates needs both to be unambiguous about which lines fed which row.
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
}

export interface BillToBlock {
  name: string;
  gstin: string | null;
  addressLines: string[];
}

export interface BankBlock {
  bank: string | null;
  accountName: string | null;
  accountNo: string | null;
  ifsc: string | null;
  branch: string | null;
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

  signatory: string | null;
  notes: string[];
  bank: BankBlock;
  terms: string[];
}
