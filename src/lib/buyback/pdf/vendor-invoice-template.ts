/**
 * The invoice iTarang issues to the VENDOR (M12).
 *
 * A PURE template. It is vendor-facing, so it inherits the same rule as the
 * quotation: NO DEALER IDENTITY, and no margin. The input type below has a field
 * for neither — it carries the agreed vendor prices and nothing else. iTarang
 * sells to the vendor as principal; where the batteries came from is not on the
 * document, by design (non-circumvention).
 *
 * The number is on OUR series (INV-5001-V, from buyback_invoice_no_seq). That is
 * the one invoice number we may issue — the dealer's is theirs, on their series.
 *
 * Tax is deliberately absent, as on every other buyback document: GST/HSN/
 * reverse-charge is an open item (BRD §10) that gates the first live deal. The
 * document says so rather than implying a treatment nobody has agreed to.
 *
 * ⚠ THIS IS NOT A COMPLIANT GST TAX INVOICE YET. It is a commercial invoice.
 * Before the first live deal it needs HSN per line, the tax split, the
 * reverse-charge declaration and iTarang's GSTIN — the columns are already on
 * invoice_lines waiting for Chirag's ruling.
 */

import { inr } from "../format";

export interface VendorInvoiceLine {
  spec_label: string;
  condition: string;
  condition_key: "WORKING" | "DEAD";
  quantity: number;
  /** ₹/unit the vendor AGREED. Never the dealer price, never the margin. */
  price_per_unit: number;
}

export interface VendorInvoiceInput {
  number: string;
  issued_on: Date | string;
  /** The vendor. They are the addressee. */
  buyer: { name: string; gstin?: string | null; city?: string | null; state?: string | null };
  lines: VendorInvoiceLine[];
  total: number;
  /** Their PO to us, so they can match it in their own system. */
  their_po_number?: string | null;
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const day = (d: Date | string): string => {
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

export function renderVendorInvoiceHtml(input: VendorInvoiceInput): string {
  const rows = input.lines
    .map(
      (l) => `
      <tr>
        <td>
          <div class="spec">${esc(l.spec_label)}</div>
          <div class="cond ${l.condition_key === "WORKING" ? "ok" : "dead"}">${esc(l.condition)}</div>
        </td>
        <td class="num">${l.quantity}</td>
        <td class="num">${esc(inr(l.price_per_unit))}</td>
        <td class="num strong">${esc(inr(l.price_per_unit * l.quantity))}</td>
      </tr>`,
    )
    .join("");

  const units = input.lines.reduce((n, l) => n + l.quantity, 0);
  const where = [input.buyer.city, input.buyer.state].filter(Boolean).join(", ");

  return `
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: Inter, "Helvetica Neue", Arial, sans-serif; color: #0F172A; font-size: 12px; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-start;
          border-bottom: 2px solid #0B2239; padding-bottom: 12px; margin-bottom: 18px; }
  .brand { font-size: 19px; font-weight: 800; color: #0B2239; letter-spacing: -.2px; }
  .brand small { display: block; font-size: 10px; font-weight: 600; color: #64748B;
                 letter-spacing: .6px; text-transform: uppercase; margin-top: 3px; }
  .meta { text-align: right; font-size: 11px; color: #64748B; line-height: 1.7; }
  .meta b { color: #0F172A; }
  h1 { font-size: 14px; margin: 0 0 14px; }
  .parties { display: flex; gap: 12px; margin-bottom: 16px; }
  .party { flex: 1; background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 8px; padding: 11px 14px; }
  .lbl { font-size: 9.5px; font-weight: 700; color: #94A3B8;
         text-transform: uppercase; letter-spacing: .5px; margin-bottom: 3px; }
  .nm { font-weight: 700; }
  .sub { font-size: 10.5px; color: #64748B; margin-top: 3px; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
  th { text-align: left; font-size: 9.5px; font-weight: 700; color: #94A3B8;
       text-transform: uppercase; letter-spacing: .5px; padding: 8px 10px;
       background: #FAFBFC; border-bottom: 1px solid #E5E7EB; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td { padding: 10px; border-bottom: 1px solid #F1F5F9; vertical-align: top; }
  td.strong { font-weight: 700; }
  .spec { font-weight: 700; font-size: 12.5px; }
  .cond { display: inline-block; font-size: 9.5px; font-weight: 700; padding: 2px 7px;
          border-radius: 5px; margin-top: 4px; }
  .cond.ok   { background: #DCFCE7; color: #15803D; }
  .cond.dead { background: #FEE2E2; color: #B91C1C; }
  tfoot td { border-top: 2px solid #0B2239; border-bottom: none; font-weight: 800; padding-top: 10px; }
  .note { background: #FFFBEB; border: 1px solid #FDE68A; color: #92400E; border-radius: 8px;
          padding: 9px 12px; font-size: 10.5px; margin-bottom: 12px; }
  .foot { margin-top: 22px; padding-top: 10px; border-top: 1px solid #E5E7EB;
          font-size: 9.5px; color: #94A3B8; line-height: 1.6; }
</style>

<div class="head">
  <div class="brand">iTarang<small>Battery Buyback</small></div>
  <div class="meta">
    <div>Invoice <b>${esc(input.number)}</b></div>
    <div>Issued <b>${day(input.issued_on)}</b></div>
    ${input.their_po_number ? `<div>Your PO <b>${esc(input.their_po_number)}</b></div>` : ""}
  </div>
</div>

<h1>Invoice</h1>

<div class="parties">
  <div class="party">
    <div class="lbl">From</div>
    <div class="nm">iTarang Technologies</div>
    <div class="sub">Selling the batteries below as principal.</div>
  </div>
  <div class="party">
    <div class="lbl">Bill to</div>
    <div class="nm">${esc(input.buyer.name)}</div>
    <div class="sub">
      ${where ? esc(where) : ""}
      ${input.buyer.gstin ? `<br />GSTIN ${esc(input.buyer.gstin)}` : ""}
    </div>
  </div>
</div>

<!--
  As on the quotation: there is no consignor block, and the originating dealer is
  not named. The type this template receives carries neither their identity nor
  our margin, so neither can be printed.
-->

<table>
  <thead>
    <tr>
      <th>Battery</th>
      <th class="num">Qty</th>
      <th class="num">Rate (₹/unit)</th>
      <th class="num">Amount</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
  <tfoot>
    <tr>
      <td>Total — ${units} unit${units === 1 ? "" : "s"}</td>
      <td class="num"></td>
      <td class="num"></td>
      <td class="num">${esc(inr(input.total))}</td>
    </tr>
  </tfoot>
</table>

<div class="note">
  <b>Tax treatment pending.</b> Figures are exclusive of GST. The applicable
  GST / HSN classification and reverse-charge treatment will be confirmed before
  payment is due. This document is a commercial invoice, not yet a GST tax invoice.
</div>

<div class="foot">
  Payable at the agreed per-battery rates above. Please quote
  <b>${esc(input.number)}</b> on the remittance.
</div>
`;
}
