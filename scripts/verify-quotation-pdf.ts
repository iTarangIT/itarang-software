/**
 * E-242 — render the reference quotation and check its numbers.
 *
 * Renders the exact data from docs/ITPI-35 (1).pdf through the real template
 * and the real PDF pipeline, then asserts the four totals that document prints.
 * The unit tests already pin the arithmetic; what this adds is proof that the
 * whole chain — view → HTML → headless Chrome → bytes — actually runs on this
 * machine, which is the half a pure test cannot reach.
 *
 * Writes the PDF to reports/ so the layout can be eyeballed against the
 * original after a template change.
 *
 *   npx tsx scripts/verify-quotation-pdf.ts
 *
 * No database and no network: the config defaults are used directly rather than
 * resolved from app_settings, so this runs anywhere.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommercialsProductLine } from "../src/lib/inside-sales/types";
import { DEFAULT_QUOTATION_CONFIG } from "../src/lib/leads/quote-pdf/config";
import { renderProformaHtml } from "../src/lib/leads/quote-pdf/proforma-template";
import {
  buildQuotationView,
  composeBillToAddress,
  taxRefKey,
} from "../src/lib/leads/quote-pdf/view";
import type { LineTaxRef } from "../src/lib/leads/quote-pdf/view";
import { renderPdfFromHtml } from "../src/lib/pdf/render-html";

const LINES: CommercialsProductLine[] = [
  {
    asset_type: "battery",
    product_id: "p1",
    product_name: "Trontek Li Battery Pack 51v 105Ah",
    model_id: "TRO-51-105",
    unit_price: 44_000,
    quantity: 15,
  },
  {
    asset_type: "charger",
    product_id: "p2",
    product_name: "Trontek EV Charger 48V 25Amp",
    model_id: "TRO-CHG-48-25",
    unit_price: 6_500,
    quantity: 15,
  },
  {
    asset_type: "paraphernalia",
    product_id: "p3",
    product_name: "LCD Display with Box",
    model_id: "LCD-BOX",
    unit_price: 600,
    quantity: 15,
  },
  {
    asset_type: "paraphernalia",
    product_id: "p4",
    product_name: "IOT (2 year subscription)",
    model_id: "IOT-2Y",
    unit_price: 5_000,
    quantity: 15,
  },
];

const TAX_REFS = new Map<string, LineTaxRef>([
  [taxRefKey("battery", "p1"), { hsnCode: "85076000", gstRatePct: 18 }],
  [taxRefKey("charger", "p2"), { hsnCode: "85044030", gstRatePct: 5 }],
  [taxRefKey("paraphernalia", "p3"), { hsnCode: "85079090", gstRatePct: 18 }],
  [taxRefKey("paraphernalia", "p4"), { hsnCode: "85076000", gstRatePct: 18 }],
]);

/** Straight off the reference document. */
const EXPECTED = {
  subTotal: 841_500,
  igst18: 133_920,
  igst5: 4_875,
  total: 980_295,
  words: "Indian Rupee Nine Lakh Eighty Thousand Two Hundred Ninety-Five Only",
};

async function main() {
  // The defaults exactly as they ship — no logo, no signature block, no
  // commercialTerms. The eyeball comparison against ITPI-35 is now about layout
  // and numbers only: our document deliberately carries neither of its images,
  // and is headed "Quotation" rather than "Proforma Invoice".
  const view = buildQuotationView({
    quoteNumber: "ITQ-2026-0001",
    quoteDate: new Date("2026-08-13T06:00:00.000Z"),
    config: DEFAULT_QUOTATION_CONFIG,
    lines: LINES,
    taxRefs: TAX_REFS,
    placeOfSupply: { stateCode: "05", label: "Uttarakhand (05)" },
    // The full Bill To block, composed the way quoteDraft.ts composes it from
    // the lead's own columns — so this render exercises the address/mobile
    // lines and not just the name.
    dealer: {
      name: "Himadri Enterprises",
      gstin: "05EAUPB2253Q1Z8",
      addressLines: composeBillToAddress({
        area: "Transport Nagar",
        location: "Haldwani",
        city: "Haldwani",
        state: "Uttarakhand",
        pincode: "263139",
      }),
      phone: "+919876543210",
    },
  });

  const failures: string[] = [];
  const check = (label: string, got: unknown, want: unknown) => {
    const ok = got === want;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: ${String(got)}`);
    if (!ok) failures.push(`${label} — expected ${String(want)}, got ${String(got)}`);
  };

  console.log("Reference document: docs/ITPI-35 (1).pdf\n");
  // Both deliberately absent — asserted so a re-added default is caught here
  // rather than on a document already with a dealer.
  check("No letterhead image", view.seller.logoDataUri, null);
  check("No signature block", view.signatureDataUri, null);
  check("Document title", view.documentTitle, "Quotation");
  check("Sub Total", view.subTotal, EXPECTED.subTotal);
  // The reference document heads these rows IGST; ours say GST (2026-08-20).
  // The LABEL is asserted, not just the amount, so a register silently changing
  // name again is caught here and not on a document already with a dealer.
  check("Tax row 1 label", view.taxRows[0]?.label, "GST18 (18%)");
  check("Tax row 1 amount", view.taxRows[0]?.amount, EXPECTED.igst18);
  check("Tax row 2 label", view.taxRows[1]?.label, "GST5 (5%)");
  check("Tax row 2 amount", view.taxRows[1]?.amount, EXPECTED.igst5);
  check("Total", view.total, EXPECTED.total);
  check("Total In Words", view.totalInWords, EXPECTED.words);
  check("Place Of Supply", view.placeOfSupply, "Uttarakhand (05)");
  check("Quote Date", view.quoteDate, "13/08/2026");
  check("Tax split", view.isIntraState ? "CGST+SGST" : "integrated", "integrated");
  // The Bill To block carries the lead's address and mobile, not just a name.
  check("Bill To line 1", view.billTo.addressLines[0], "Transport Nagar");
  check("Bill To line 2", view.billTo.addressLines[1], "Haldwani, Uttarakhand 263139");
  check("Bill To mobile", view.billTo.phone, "+919876543210");

  const html = renderProformaHtml(view);
  console.log("\nRendering PDF through the real pipeline…");
  const pdf = await renderPdfFromHtml(html);

  // A PDF that renders to a near-empty page still "succeeds" — check the bytes
  // are a real document rather than trusting the absence of a throw.
  const isPdf = pdf.subarray(0, 5).toString() === "%PDF-";
  check("Output is a PDF", isPdf, true);
  console.log(`  INFO  ${pdf.byteLength.toLocaleString()} bytes`);
  if (pdf.byteLength < 5_000) {
    failures.push(`PDF is suspiciously small (${pdf.byteLength} bytes)`);
  }

  const dir = join(process.cwd(), "reports");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "quotation-format-check.pdf");
  writeFileSync(out, pdf);
  console.log(`\nWrote ${out}`);
  console.log("Compare it against docs/ITPI-35 (1).pdf by eye for layout.\n");

  if (failures.length) {
    console.error("FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("All reference numbers match.");
  process.exit(0);
}

main().catch((e) => {
  console.error("verify-quotation-pdf failed:", e);
  process.exit(1);
});
