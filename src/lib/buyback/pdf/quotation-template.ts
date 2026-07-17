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
 *
 * Item 14 widened what it shows, not what it may show. The rule is unchanged and
 * the signature still enforces it; what changed is that the view now carries the
 * E-191 battery spec, so the document finally states the two things a scrap
 * buyer actually prices on — CHEMISTRY and KILOGRAMS. It used to say "60V 120Ah
 * · Working ×3" and stop.
 *
 * Two of those fields are single strings rather than data + a flag, and that is
 * deliberate: `iot_brand_label` carries "(assumed)" inside it, and
 * `condition_split_label` carries the untested remainder inside it. A template
 * cannot render the fact and drop the caveat, because there is no bare fact to
 * render. The same reasoning as the type having no dealer fields: make the
 * mistake unrepresentable rather than forbidden.
 *
 * This file no longer caps the photo count. It used to `.slice(0, 3)` whatever
 * it was handed, which meant a caller that computed a byte budget for six was
 * computing fiction, and any "showing N of M" caption would have been a document
 * lying about itself. The route caps; this renders what it is given.
 */

import { inr } from "../format";
import type { VendorQuotationView } from "../serialize";

export interface QuotationTemplateInput {
  quotation: VendorQuotationView;
  vendorName: string;
  /**
   * How many photos ride with the EMAIL as attachments (E-198).
   *
   * The document does not embed them any more. It used to inline base64 data
   * URIs — which forced a 2-per-line cap and a 54x40px render, at which size a
   * swollen cell and a healthy one are indistinguishable, defeating the reason
   * for sending photos at all. Now the mailer attaches the real files and this
   * is only so the PDF can TELL the reader they exist; a document that shows no
   * photos and says nothing about them reads as a document with no photos.
   */
  photoCount?: number;
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
  const { quotation: q, vendorName, photoCount = 0, validUntil } = input;

  const location = [q.pickup_city, q.pickup_state].filter(Boolean).join(", ") || "—";

  const rows = q.lines
    .map((line) => {
      // What a scrap buyer actually prices on. Every part is a property of the
      // BATTERY — none of it identifies the seller. Null parts are OMITTED, not
      // rendered as "—": a dash reads as "we asked and it has none", which is a
      // different claim from "the dealer did not declare this".
      const meta = [
        line.variant_type,
        line.brand,
        line.chemistry,
        line.form_factor,
        line.nominal_voltage && line.nominal_ampere
          ? `${line.nominal_voltage}V ${line.nominal_ampere}Ah nominal`
          : null,
        line.unit_weight_kg ? `${line.unit_weight_kg} kg/unit` : null,
        line.line_weight_kg ? `${line.line_weight_kg} kg total` : null,
        // "rated", always. warranty_cycles is design life, not consumed life —
        // printing it bare would let a vendor read it as the cycle count they
        // asked for, which we do not have.
        line.warranty_cycles ? `${line.warranty_cycles} cycles rated` : null,
        line.condition_split_label,
        // Already carries "(assumed)" when we guessed. One string, so it cannot
        // be rendered without its provenance.
        line.iot_battery === false ? "Non-IOT" : line.iot_brand_label,
      ]
        .filter(Boolean)
        .map((part) => esc(part))
        .join(" · ");

      return `
      <tr>
        <td>
          <div class="spec">${esc(line.spec_label)}</div>
          <div class="cond ${line.condition_key === "WORKING" ? "ok" : "dead"}">${esc(line.condition)}</div>
          ${meta ? `<div class="linemeta">${meta}</div>` : ""}
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
  .linemeta { margin-top: 5px; font-size: 10.5px; color: #475569; line-height: 1.5; }
  .photonote { background: #EFF6FF; border: 1px solid #BFDBFE; color: #1E40AF; border-radius: 8px;
               padding: 9px 12px; font-size: 10.5px; margin-bottom: 12px; }
  tfoot td { border-top: 2px solid #0B2239; border-bottom: none; font-weight: 800; padding-top: 10px; }
  .wt { display: block; margin-top: 3px; font-size: 10.5px; font-weight: 600; color: #475569; }
  .wt em { font-style: normal; font-weight: 500; color: #94A3B8; }
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
      <td>
        Total — ${q.total_units} unit${q.total_units === 1 ? "" : "s"}
        ${
          // The number a scrap buyer actually prices on, and the one the
          // document never carried. The caveat rides WITH it: a total covering
          // 4 of 6 SKUs, printed bare, reads as the weight of the lot.
          q.total_weight_kg !== null
            ? `<span class="wt">${esc(q.total_weight_kg)} kg${
                q.weight_caveat ? ` <em>(${esc(q.weight_caveat)})</em>` : ""
              }</span>`
            : ""
        }
      </td>
      <td class="num"></td>
      <td class="num"></td>
      <td class="num">${esc(inr(q.ask_total))}</td>
    </tr>
  </tfoot>
</table>

${
  // The photos are attached to the email, not embedded here. Say so: a
  // quotation with no images and no mention of any reads as a lot nobody
  // photographed — which is the opposite of the truth (the submit gate demands
  // at least five per battery line before a request can even be sent).
  photoCount > 0
    ? `<div class="photonote">
  <b>${photoCount} battery photo${photoCount === 1 ? "" : "s"} attached to this email.</b>
  Full quality, front / back / label / serial. You do not need an account to view them.
</div>`
    : ""
}

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
