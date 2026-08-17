/**
 * The dealer quotation document, laid out to match docs/ITPI-35 (1).pdf.
 *
 * The file and function keep the "proforma" name because the LAYOUT is
 * ITPI-35's. The document itself is headed "Quotation" as of 2026-08-17 — an
 * offer, not an instrument to pay against — and the heading is config, not code
 * (QuotationDocConfig.documentTitle), so it can change again without touching
 * this file.
 *
 * A PURE template: QuotationView in, HTML out. No DB, no config lookup, no
 * rendering engine, no I/O of any kind. Everything it prints was decided by
 * toQuotationView() and computeTotals(); this file chooses only where things sit
 * on the page.
 *
 * THE SIGNATURE IS THE POINT. It accepts a QuotationView and nothing else, so
 * it cannot reach for a field somebody later decides should not appear on a
 * dealer-facing document — the same discipline as
 * src/lib/buyback/pdf/quotation-template.ts, where the view type makes a
 * forbidden field unrepresentable rather than merely omitted.
 *
 * THE TEMPLATE DOES NOT CALCULATE. Every money value arrives already rounded to
 * paise. If this file did arithmetic, the totals asserted in
 * __tests__/tax.test.ts against the reference document would no longer be the
 * totals that print, and the only way to check the document would be to render
 * and read it.
 *
 * Self-contained by necessity: renderPdfFromHtml() waits on `domcontentloaded`,
 * not on the network, so an external stylesheet or webfont would simply not
 * arrive. Everything is inline.
 */
import type { QuotationView } from "./types";

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Indian digit grouping with exactly two decimals — "8,41,500.00".
 *
 * NOT src/lib/buyback/format.ts's inr(): that one rounds to whole rupees and
 * prefixes ₹, and this document prints paise everywhere and the symbol only on
 * the grand total.
 */
function money(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/** Quantities print as "15.00", matching the reference document. */
function qty(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/** The marker for a rate the catalogue has not been given. Never "0%". */
const UNSET_TAX = '<span class="unset">Not set</span>';

export function renderProformaHtml(view: QuotationView): string {
  const taxHeaderLabel = view.isIntraState ? "GST" : "IGST";

  const lineRows = view.lines
    .map((line) => {
      const rateCell =
        line.gstRatePct == null
          ? UNSET_TAX
          : `${esc(String(line.gstRatePct))}%`;
      const taxAmountCell =
        line.gstAmount == null ? UNSET_TAX : esc(money(line.gstAmount));

      return `
      <tr>
        <td class="idx">${line.index}</td>
        <td>
          <div class="item">${esc(line.description)}</div>
          ${line.descriptionNote ? `<div class="itemnote">${esc(line.descriptionNote)}</div>` : ""}
        </td>
        <td class="hsn">${line.hsnCode ? esc(line.hsnCode) : "—"}</td>
        <td class="num">${esc(qty(line.quantity))}${line.unit ? `<span class="unit">${esc(line.unit)}</span>` : ""}</td>
        <td class="num">${esc(money(line.rate))}</td>
        <td class="num pct">${rateCell}</td>
        <td class="num">${taxAmountCell}</td>
        <td class="num strong">${esc(money(line.amount))}</td>
      </tr>`;
    })
    .join("");

  const taxRows = view.taxRows
    .map(
      (r) => `
      <tr>
        <td class="tlabel">${esc(r.label)}</td>
        <td class="num">${esc(money(r.amount))}</td>
      </tr>`,
    )
    .join("");

  const notes = view.notes
    .map((n) => `<div class="noteline">${esc(n)}</div>`)
    .join("");

  const terms = view.terms
    .map((t) => `<li>${esc(t)}</li>`)
    .join("");

  // What was agreed with THIS dealer, as opposed to the standing small print
  // in `terms` below. Same filter-then-map shape as the bank block: a term
  // nobody set prints no row, so a quote raised before these were carried on
  // the document renders exactly as it did.
  const dealTermRows = [
    ["Payment", view.commercialTerms.paymentMethod],
    ["Credit period", view.commercialTerms.creditTerms],
    ["Delivery", view.commercialTerms.deliveryTerms],
    ["Warranty", view.commercialTerms.warranty],
    ["Notes", view.commercialTerms.dealNotes],
  ]
    .filter(([, v]) => !!v)
    .map(
      ([k, v]) =>
        `<div class="dealterm"><span class="k">${esc(k)}</span><span>${esc(v)}</span></div>`,
    )
    .join("");

  const bankRows = [
    ["Bank", view.bank.bank],
    ["Name", view.bank.accountName],
    ["Account No", view.bank.accountNo],
    ["IFSC", view.bank.ifsc],
    ["Branch", view.bank.branch],
  ]
    .filter(([, v]) => !!v)
    .map(
      ([k, v]) =>
        `<div class="bankline"><span>${esc(k)}:</span> ${esc(v)}</div>`,
    )
    .join("");

  return `
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: Inter, "Helvetica Neue", Arial, sans-serif; color: #0F172A;
         font-size: 11px; margin: 0; }

  .head { display: flex; justify-content: space-between; align-items: flex-start;
          border-bottom: 2px solid #0B2239; padding-bottom: 14px; margin-bottom: 16px; }
  /* Height-constrained, width auto: the mark keeps its aspect ratio whatever
     file is configured, and a taller replacement cannot push the letterhead
     off the first page. */
  .logo { height: 34px; width: auto; display: block; margin-bottom: 7px; }
  .brand { font-size: 16px; font-weight: 800; color: #0B2239; letter-spacing: -.2px; }
  .addr { font-size: 10px; color: #475569; line-height: 1.65; margin-top: 5px; }
  .addr .gst { color: #0F172A; font-weight: 600; margin-top: 4px; }

  .docmeta { text-align: right; min-width: 210px; }
  .doctitle { font-size: 15px; font-weight: 800; color: #0B2239; margin-bottom: 7px; }
  .metarow { font-size: 10.5px; color: #475569; line-height: 1.75;
             display: flex; justify-content: flex-end; gap: 6px; }
  .metarow b { color: #0F172A; font-weight: 600; }
  .metarow .k { color: #94A3B8; }

  .to { background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 8px;
        padding: 10px 13px; margin-bottom: 14px; }
  .lbl { font-size: 9px; font-weight: 700; color: #94A3B8;
         text-transform: uppercase; letter-spacing: .5px; }
  .toname { font-size: 13px; font-weight: 700; margin-top: 3px; }
  .togst { font-size: 10px; color: #475569; margin-top: 2px; }

  .warn { background: #FEF3C7; border: 1px solid #F59E0B; color: #78350F;
          border-radius: 7px; padding: 8px 12px; margin-bottom: 13px;
          font-size: 10.5px; font-weight: 600; }

  table.items { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  table.items th { text-align: left; font-size: 9px; font-weight: 700; color: #94A3B8;
       text-transform: uppercase; letter-spacing: .4px; padding: 7px 8px;
       background: #FAFBFC; border-bottom: 1px solid #E5E7EB;
       /* "IGST %" and "IGST Amt" otherwise break across two lines and shove the
          header row out of alignment with the numbers under it. */
       white-space: nowrap; }
  table.items th.num, table.items td.num { text-align: right;
       font-variant-numeric: tabular-nums; }
  table.items td { padding: 9px 8px; border-bottom: 1px solid #F1F5F9;
       vertical-align: top; }
  td.idx { color: #94A3B8; width: 22px; }
  td.hsn { color: #475569; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.strong { font-weight: 700; }
  .item { font-weight: 600; font-size: 11.5px; }
  .itemnote { color: #64748B; font-size: 10px; margin-top: 2px; }
  .unit { color: #94A3B8; font-weight: 400; margin-left: 3px; }
  .unset { color: #B45309; font-weight: 700; font-size: 9.5px;
           white-space: nowrap; }

  .totalswrap { display: flex; justify-content: flex-end; margin-bottom: 12px; }
  table.totals { border-collapse: collapse; min-width: 270px; }
  table.totals td { padding: 6px 9px; font-size: 11px; }
  table.totals td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.totals td.tlabel { color: #475569; }
  table.totals tr.sub td { border-top: 1px solid #E5E7EB; }
  table.totals tr.grand td { border-top: 2px solid #0B2239; font-size: 13px;
       font-weight: 800; color: #0B2239; padding-top: 8px; }

  .words { font-size: 10.5px; color: #0F172A; margin-bottom: 18px; }
  .words .lbl { display: block; margin-bottom: 2px; }

  .sign { text-align: right; margin-bottom: 20px; }
  .signname { font-size: 11.5px; font-weight: 600; }
  .signrule { border-top: 1px solid #CBD5E1; width: 175px; margin: 26px 0 4px auto; }
  .signlbl { font-size: 9.5px; color: #64748B; }
  /* Height-constrained like the letterhead mark, so replacing the scan with a
     differently-proportioned one cannot shove the terms onto a second page. */
  .signimg { height: 62px; width: auto; display: inline-block; margin-bottom: 2px; }

  .foot { display: flex; gap: 22px; border-top: 1px solid #E5E7EB; padding-top: 12px; }
  .foot > div { flex: 1; }
  .noteline { font-size: 10.5px; color: #334155; margin-bottom: 3px; }
  .bankline { font-size: 10px; color: #334155; line-height: 1.6; }
  .bankline span { color: #94A3B8; }
  ol.terms { margin: 5px 0 0; padding-left: 15px; }
  ol.terms li { font-size: 9.8px; color: #334155; line-height: 1.55; margin-bottom: 2px; }
  .sectlbl { font-size: 9px; font-weight: 700; color: #94A3B8;
             text-transform: uppercase; letter-spacing: .5px; margin-bottom: 5px; }

  /* This deal's terms. Bordered and above the signature so they read as part
     of the offer being signed, not as more small print. */
  .dealterms { border: 1px solid #E5E7EB; border-radius: 4px;
               padding: 9px 11px; margin-bottom: 12px; }
  .dealterm { font-size: 10.5px; color: #0F172A; line-height: 1.7;
              display: flex; gap: 8px; }
  .dealterm .k { color: #475569; min-width: 96px; }
</style>

<div class="head">
  <div>
    ${
      view.seller.logoDataUri
        ? `<img class="logo" src="${esc(view.seller.logoDataUri)}" alt="${esc(view.seller.legalName)}"/>`
        : ""
    }
    <div class="brand">${esc(view.seller.legalName)}</div>
    <div class="addr">
      ${view.seller.addressLines.map((l) => esc(l)).join("<br/>")}
      ${view.seller.gstin ? `<div class="gst">GSTIN ${esc(view.seller.gstin)}</div>` : ""}
      ${view.seller.email ? `<div>${esc(view.seller.email)}</div>` : ""}
      ${view.seller.website ? `<div>${esc(view.seller.website)}</div>` : ""}
    </div>
  </div>
  <div class="docmeta">
    <div class="doctitle">${esc(view.documentTitle)}</div>
    <div class="metarow"><span class="k">#</span><b>${esc(view.quoteNumber)}</b></div>
    <div class="metarow"><span class="k">Quote Date</span><b>${esc(view.quoteDate)}</b></div>
    ${
      view.placeOfSupply
        ? `<div class="metarow"><span class="k">Place Of Supply</span><b>${esc(view.placeOfSupply)}</b></div>`
        : ""
    }
  </div>
</div>

<div class="to">
  <div class="lbl">Bill To</div>
  <div class="toname">${esc(view.billTo.name)}</div>
  ${view.billTo.addressLines.length ? `<div class="togst">${view.billTo.addressLines.map((l) => esc(l)).join("<br/>")}</div>` : ""}
  ${view.billTo.gstin ? `<div class="togst">GSTIN ${esc(view.billTo.gstin)}</div>` : ""}
</div>

${
  view.hasUnsetTax
    ? `<div class="warn">Some lines have no GST rate on file, so no tax has been applied to them.
       Set the rate on the product master before sending this quotation.</div>`
    : ""
}

<table class="items">
  <thead>
    <tr>
      <th>#</th>
      <th>Item &amp; Description</th>
      <th>HSN/SAC</th>
      <th class="num">Qty</th>
      <th class="num">Rate</th>
      <th class="num">${esc(taxHeaderLabel)} %</th>
      <th class="num">${esc(taxHeaderLabel)} Amt</th>
      <th class="num">Amount</th>
    </tr>
  </thead>
  <tbody>${lineRows}</tbody>
</table>

<div class="totalswrap">
  <table class="totals">
    <tr class="sub">
      <td class="tlabel">Sub Total</td>
      <td class="num">${esc(money(view.subTotal))}</td>
    </tr>
    ${taxRows}
    <tr class="grand">
      <td class="tlabel">Total</td>
      <td class="num">₹${esc(money(view.total))}</td>
    </tr>
  </table>
</div>

<div class="words">
  <span class="lbl">Total In Words</span>
  <i>${esc(view.totalInWords)}</i>
</div>

${
  dealTermRows
    ? `<div class="dealterms">
         <div class="sectlbl">Terms Of This Quotation</div>
         ${dealTermRows}
       </div>`
    : ""
}

${
  /*
   * The scanned block when there is one, the typed fallback otherwise.
   *
   * The scan already reads "For ITARANG TECHNOLOGIES LLP … Designated Partner",
   * so the rule and the "Authorized Signature" caption are dropped with it —
   * printing both gives the document two titles for one signatory. The name is
   * still printed underneath, because the signature itself does not spell it
   * and a document should say who signed it.
   */
  view.signatureDataUri
    ? `<div class="sign">
         <img class="signimg" src="${esc(view.signatureDataUri)}" alt="${esc(view.signatory ?? "Authorized signature")}"/>
         ${view.signatory ? `<div class="signname">${esc(view.signatory)}</div>` : ""}
       </div>`
    : view.signatory
      ? `<div class="sign">
           <div class="signrule"></div>
           <div class="signname">${esc(view.signatory)}</div>
           <div class="signlbl">Authorized Signature</div>
         </div>`
      : ""
}

<div class="foot">
  <div>
    ${notes ? `<div class="sectlbl">Notes</div>${notes}` : ""}
    ${
      bankRows
        ? `<div class="sectlbl" style="margin-top:10px">Company's Bank Account Details</div>${bankRows}`
        : ""
    }
  </div>
  ${
    terms
      ? `<div>
           <div class="sectlbl">Terms &amp; Conditions</div>
           <ol class="terms">${terms}</ol>
         </div>`
      : ""
  }
</div>
`;
}
