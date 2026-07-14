/**
 * The vendor quotation (M09).
 *
 * A PURE template: HTML in, HTML out. No I/O, no DB, no S3 — photos arrive as
 * already-inlined data: URIs.
 *
 * THE POINT OF THIS FILE'S SIGNATURE: it accepts a VendorQuotationView and
 * nothing else. That type is built field-by-field by toVendorQuotation() and has
 * no dealer name, phone, GSTIN, address line or pincode on it. So the M09 AC —
 * "PDF contains no dealer name/phone/GST" — is not a promise this template keeps
 * by remembering not to write {{dealerName}}. It is a promise it CANNOT break,
 * because it is never handed one. iTarang is a back-to-back principal: a vendor
 * who can identify the dealer can go around us.
 *
 * Tax is deliberately absent. GST/HSN/reverse-charge is an open item (BRD §10)
 * that gates the first live deal and is Chirag's call — so the document is
 * explicitly tax-exclusive and says so, rather than quietly implying a treatment
 * nobody has agreed to.
 */

import { inr } from "../format";
import type { VendorQuotationView } from "../serialize";

export interface QuotationTemplateInput {
  quotation: VendorQuotationView;
  vendorName: string;
  /** Already-inlined data: URIs, keyed by line_id. The template does no fetching. */
  photosByLine?: Record<string, string[]>;
  /** BRD §6 — quotes expire (72h default). */
  validUntil?: Date | string | null;
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const day = (d: Date | string | null | undefined): string => {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

export function renderQuotationHtml(input: QuotationTemplateInput): string {
  const { quotation: q, vendorName, photosByLine = {}, validUntil } = input;

  const location = [q.pickup_city, q.pickup_state].filter(Boolean).join(", ") || "—";

  const rows = q.lines
    .map((line) => {
      const photos = (photosByLine[line.line_id] ?? [])
        .slice(0, 3)
        .map((src) => `<img class="ph" src="${src}" alt="" />`)
        .join("");

      return `
      <tr>
        <td>
          <div class="spec">${esc(line.spec_label)}</div>
          <div class="cond ${line.condition_key === "WORKING" ? "ok" : "dead"}">${esc(line.condition)}</div>
          ${photos ? `<div class="photos">${photos}</div>` : ""}
        </td>
        <td class="num">${line.quantity}</td>
        <td class="num">${esc(inr(line.ask_price))}</td>
        <td class="num strong">${esc(inr(Number(line.ask_price ?? 0) * line.quantity))}</td>
      </tr>`;
    })
    .join("");

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
  h1 { font-size: 14px; margin: 0 0 3px; }
  .to { background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 8px;
        padding: 11px 14px; margin-bottom: 16px; }
  .lbl { font-size: 9.5px; font-weight: 700; color: #94A3B8;
         text-transform: uppercase; letter-spacing: .5px; }
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
  .photos { margin-top: 7px; display: flex; gap: 4px; }
  .ph { width: 54px; height: 40px; object-fit: cover; border-radius: 4px; border: 1px solid #E5E7EB; }
  tfoot td { border-top: 2px solid #0B2239; border-bottom: none; font-weight: 800; padding-top: 10px; }
  .note { background: #FFFBEB; border: 1px solid #FDE68A; color: #92400E; border-radius: 8px;
          padding: 9px 12px; font-size: 10.5px; margin-bottom: 12px; }
  .foot { margin-top: 20px; padding-top: 10px; border-top: 1px solid #E5E7EB;
          font-size: 9.5px; color: #94A3B8; line-height: 1.6; }
</style>

<div class="head">
  <div class="brand">iTarang<small>Battery Buyback</small></div>
  <div class="meta">
    <div>Quotation <b>${esc(q.quotation_no)}</b></div>
    <div>Issued <b>${day(q.issued_on)}</b></div>
    ${validUntil ? `<div>Valid until <b>${day(validUntil)}</b></div>` : ""}
  </div>
</div>

<h1>Request for quotation — end-of-life batteries</h1>

<div class="to">
  <div class="lbl">To</div>
  <div style="font-weight:700; margin:2px 0 8px;">${esc(vendorName)}</div>
  <div class="lbl">Collection from</div>
  <div style="font-weight:700; margin-top:2px;">${esc(location)}</div>
</div>

<!--
  NOTE FOR THE NEXT ENGINEER: there is deliberately no seller/consignor block
  here. iTarang sells to you as principal. The originating dealer is not named,
  by design (BRD M09 AC) — and the type this template receives does not carry
  their identity, so you could not print it even if you tried.
-->

<table>
  <thead>
    <tr>
      <th>Battery</th>
      <th class="num">Qty</th>
      <th class="num">Our ask (₹/unit)</th>
      <th class="num">Line total</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
  <tfoot>
    <tr>
      <td>Total — ${q.total_units} unit${q.total_units === 1 ? "" : "s"}</td>
      <td class="num"></td>
      <td class="num"></td>
      <td class="num">${esc(inr(q.ask_total))}</td>
    </tr>
  </tfoot>
</table>

<div class="note">
  <b>Tax treatment pending.</b> All figures above are exclusive of GST. The
  applicable GST / HSN classification and reverse-charge treatment will be
  confirmed on the tax invoice.
</div>

<div class="foot">
  Please respond with your price <b>per SKU</b> — we cannot accept a single
  lump-sum figure for the lot, as each variant is settled separately.<br />
  Reply to this email quoting <b>${esc(q.quotation_no)}</b>.
</div>
`;
}
