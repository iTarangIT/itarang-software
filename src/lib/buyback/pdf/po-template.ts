/**
 * The purchase order iTarang issues to the DEALER (M11 / U7).
 *
 * "iTarang PO → dealer from deal_line_locks" — so the prices printed here are
 * the locked ones, copied at generation. A later lock generation (a reopen)
 * cannot retro-change a PO that has already gone out; that is why
 * purchase_order_lines snapshots the numbers rather than joining to the lock.
 *
 * A PURE template. It is addressed TO the dealer, so it names them — that is the
 * whole point of the document. What it must never carry is the MARGIN or the
 * vendor: the dealer sees what iTarang pays them, never what iTarang sells for.
 * The input type below has no field for either.
 *
 * The vendor's PO to iTarang is not generated here — the vendor is the buyer on
 * that leg and issues their own (U7: "buyer initiates"); an admin records it.
 */

import { inr } from "../format";

export interface PoLineView {
  spec_label: string;
  condition: string;
  condition_key: "WORKING" | "DEAD";
  quantity: number;
  /** ₹/unit — the LOCKED dealer price. Never the ask, never the vendor price. */
  price_per_unit: number | string | null;
}

export interface PoTemplateInput {
  number: string;
  issued_on: Date | string;
  /** The dealer. They are the addressee — naming them is the document's purpose. */
  supplier: {
    name: string;
    gstin?: string | null;
    city?: string | null;
    state?: string | null;
  };
  lines: PoLineView[];
  total: number | null;
  pickup_address?: string | null;
  /** BB-1024 — lets the dealer tie the PO back to the request in their portal. */
  request_no?: string | null;
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

export function renderDealerPoHtml(input: PoTemplateInput): string {
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
        <td class="num strong">${esc(inr(Number(l.price_per_unit ?? 0) * l.quantity))}</td>
      </tr>`,
    )
    .join("");

  const units = input.lines.reduce((n, l) => n + l.quantity, 0);
  const where = [input.supplier.city, input.supplier.state].filter(Boolean).join(", ");

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
    <div>Purchase order <b>${esc(input.number)}</b></div>
    <div>Issued <b>${day(input.issued_on)}</b></div>
    ${input.request_no ? `<div>Request <b>${esc(input.request_no)}</b></div>` : ""}
  </div>
</div>

<h1>Purchase order</h1>

<div class="parties">
  <div class="party">
    <div class="lbl">Buyer</div>
    <div class="nm">iTarang Technologies</div>
    <div class="sub">Purchasing the batteries listed below.</div>
  </div>
  <div class="party">
    <div class="lbl">Supplier</div>
    <div class="nm">${esc(input.supplier.name)}</div>
    <div class="sub">
      ${where ? esc(where) : ""}
      ${input.supplier.gstin ? `<br />GSTIN ${esc(input.supplier.gstin)}` : ""}
    </div>
  </div>
</div>

<!--
  The prices below are the LOCKED per-SKU prices this dealer accepted
  (deal_line_locks). No margin and no vendor figure appears on this document —
  the input type carries neither.
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
  GST / HSN classification and reverse-charge treatment will be confirmed on the
  tax invoice.
</div>

${
  input.pickup_address
    ? `<div class="party" style="margin-bottom:12px;">
         <div class="lbl">Collection address</div>
         <div class="sub" style="margin-top:4px;">${esc(input.pickup_address)}</div>
       </div>`
    : ""
}

<div class="foot">
  Raise your invoice against this purchase order at the rates shown. Invoices are
  matched line by line against these rates; a mismatch on any single line is
  returned for correction, even where the total agrees.
</div>
`;
}
