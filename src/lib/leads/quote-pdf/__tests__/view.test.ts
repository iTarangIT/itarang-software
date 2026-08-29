/**
 * The whole pure path, exercised on the reference document's data:
 * product lines + tax refs -> QuotationView -> HTML.
 *
 * This is the golden test the plan called for. It asserts the four totals and
 * the words line from docs/ITPI-35 (1).pdf come out of the real mapper and land
 * in the real template — not just out of computeTotals in isolation.
 */
import { describe, expect, it } from "vitest";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { DEFAULT_QUOTATION_CONFIG, mergeQuotationConfig, stateCodeFromGstin } from "../config";
import { renderProformaHtml } from "../proforma-template";
import {
  buildQuotationView,
  composeBillToAddress,
  formatQuoteDate,
  taxRefKey,
  type LineTaxRef,
} from "../view";

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

function itpi35View() {
  return buildQuotationView({
    quoteNumber: "ITQ-2026-0001",
    quoteDate: new Date("2026-08-13T06:00:00.000Z"), // 13/08/2026 IST
    config: DEFAULT_QUOTATION_CONFIG,
    lines: LINES,
    taxRefs: TAX_REFS,
    placeOfSupply: { stateCode: "05", label: "Uttarakhand (05)" },
    dealer: { name: "Himadri Enterprises", gstin: "05EAUPB2253Q1Z8" },
  });
}

describe("buildQuotationView reproduces ITPI-35", () => {
  const view = itpi35View();

  it("computes every total printed on the reference document", () => {
    expect(view.subTotal).toBe(841_500);
    expect(view.total).toBe(980_295);
    expect(view.taxRows).toEqual([
      { label: "GST18 (18%)", amount: 133_920 },
      { label: "GST5 (5%)", amount: 4_875 },
    ]);
  });

  it("spells the total the way the document does", () => {
    expect(view.totalInWords).toBe(
      "Indian Rupee Nine Lakh Eighty Thousand Two Hundred Ninety-Five Only",
    );
  });

  it("carries each line's HSN and per-line tax", () => {
    expect(view.lines.map((l) => l.hsnCode)).toEqual([
      "85076000",
      "85044030",
      "85079090",
      "85076000",
    ]);
    expect(view.lines.map((l) => l.amount)).toEqual([660_000, 97_500, 9_000, 75_000]);
    expect(view.lines.map((l) => l.gstAmount)).toEqual([118_800, 4_875, 1_620, 13_500]);
  });

  it("formats the quote date as dd/MM/yyyy IST", () => {
    expect(view.quoteDate).toBe("13/08/2026");
  });

  it("treats Uttarakhand as inter-state against a Haryana seller", () => {
    expect(view.isIntraState).toBe(false);
    expect(view.placeOfSupply).toBe("Uttarakhand (05)");
  });

  it("flags nothing as unset, because the catalogue is complete", () => {
    expect(view.hasUnsetTax).toBe(false);
  });
});

describe("renderProformaHtml", () => {
  const html = renderProformaHtml(itpi35View());

  it("prints the reference document's totals", () => {
    expect(html).toContain("8,41,500.00");
    expect(html).toContain("1,33,920.00");
    expect(html).toContain("4,875.00");
    expect(html).toContain("₹9,80,295.00");
  });

  it("prints the letterhead, bill-to, bank and terms", () => {
    expect(html).toContain("ITARANG TECHNOLOGIES LLP");
    expect(html).toContain("GSTIN 06AALFI7813E1ZE");
    expect(html).toContain("Himadri Enterprises");
    expect(html).toContain("GSTIN 05EAUPB2253Q1Z8");
    expect(html).toContain("IDFB0022462");
    expect(html).toContain("Subject to Gurugram jurisdiction.");
    // Headed "Quotation", not "Proforma Invoice": the layout follows ITPI-35,
    // the instrument does not. A quotation is an offer; a proforma invoice is
    // something to pay against.
    expect(html).toContain("Quotation");
    expect(html).not.toContain("Proforma Invoice");
  });

  it("is self-contained — no external stylesheet, script or image", () => {
    // renderPdfFromHtml waits on domcontentloaded, so anything remote never arrives.
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(css|js|png|jpe?g|woff2?)/i);
  });

  it("escapes dealer-supplied text rather than interpolating it as markup", () => {
    const nasty = renderProformaHtml(
      buildQuotationView({
        quoteNumber: "ITQ-2026-0002",
        quoteDate: new Date("2026-08-13T06:00:00.000Z"),
        config: DEFAULT_QUOTATION_CONFIG,
        lines: LINES,
        taxRefs: TAX_REFS,
        placeOfSupply: { stateCode: "05", label: "Uttarakhand (05)" },
        dealer: { name: '<script>alert(1)</script>', gstin: null },
      }),
    );
    expect(nasty).not.toContain("<script>alert(1)</script>");
    expect(nasty).toContain("&lt;script&gt;");
  });

  it("shows the unset-tax banner and marker instead of a silent zero", () => {
    const view = buildQuotationView({
      quoteNumber: "ITQ-2026-0003",
      quoteDate: new Date("2026-08-13T06:00:00.000Z"),
      config: DEFAULT_QUOTATION_CONFIG,
      // An asset type the E-256 policy doesn't name: no catalogue rate and no
      // asset-type default, so the line must render as unset, never as 0%.
      lines: [{ ...LINES[0], asset_type: "subscription" as never }],
      taxRefs: new Map(), // catalogue has no rate for it
      placeOfSupply: { stateCode: "05", label: "Uttarakhand (05)" },
      dealer: { name: "Himadri Enterprises", gstin: null },
    });
    expect(view.hasUnsetTax).toBe(true);
    const out = renderProformaHtml(view);
    expect(out).toContain("Not set");
    expect(out).toContain("no GST rate on file");
    // The sub-total still includes the line; only the tax is withheld.
    expect(view.subTotal).toBe(660_000);
    expect(view.total).toBe(660_000);
  });

  it("falls back to the asset-type policy rate when the catalogue has none", () => {
    const view = buildQuotationView({
      quoteNumber: "ITQ-2026-0008",
      quoteDate: new Date("2026-08-13T06:00:00.000Z"),
      config: DEFAULT_QUOTATION_CONFIG,
      lines: LINES,
      taxRefs: new Map(), // masters not yet backfilled on this database
      placeOfSupply: { stateCode: "05", label: "Uttarakhand (05)" },
      dealer: { name: "Himadri Enterprises", gstin: null },
    });
    // battery 18 / charger 5 / paraphernalia 18, with the policy HSNs.
    expect(view.hasUnsetTax).toBe(false);
    expect(view.lines.map((l) => l.gstRatePct)).toEqual([18, 5, 18, 18]);
    expect(view.lines.map((l) => l.hsnCode)).toEqual([
      "85076000",
      "85044030",
      "85079090",
      "85079090",
    ]);
    // Same totals as the fully-catalogued reference document.
    expect(view.subTotal).toBe(841_500);
    expect(view.total).toBe(980_295);
  });

  it("lets a catalogue rate override the asset-type default", () => {
    const view = buildQuotationView({
      quoteNumber: "ITQ-2026-0009",
      quoteDate: new Date("2026-08-13T06:00:00.000Z"),
      config: DEFAULT_QUOTATION_CONFIG,
      lines: [LINES[0]],
      taxRefs: new Map([
        [taxRefKey("battery", "p1"), { hsnCode: "85071000", gstRatePct: 28 }],
      ]),
      placeOfSupply: { stateCode: "05", label: "Uttarakhand (05)" },
      dealer: { name: "Himadri Enterprises", gstin: null },
    });
    expect(view.lines[0].gstRatePct).toBe(28);
    expect(view.lines[0].hsnCode).toBe("85071000");
  });

  it("splits into CGST + SGST when the supply is intra-state", () => {
    const view = buildQuotationView({
      quoteNumber: "ITQ-2026-0004",
      quoteDate: new Date("2026-08-13T06:00:00.000Z"),
      config: DEFAULT_QUOTATION_CONFIG,
      lines: LINES,
      taxRefs: TAX_REFS,
      placeOfSupply: { stateCode: "06", label: "Haryana (06)" },
      dealer: { name: "A Gurugram Dealer", gstin: null },
    });
    const out = renderProformaHtml(view);
    expect(view.isIntraState).toBe(true);
    expect(out).toContain("CGST9 (9%)");
    expect(out).toContain("SGST9 (9%)");
    expect(out).not.toContain("GST18 (18%)");
    // The word IGST left the document entirely on 2026-08-20.
    expect(out).not.toContain("IGST");
  });
});

describe("line mapping decisions", () => {
  it("keeps an unpriced line on the document at zero rather than dropping it", () => {
    const view = buildQuotationView({
      quoteNumber: "ITQ-2026-0005",
      quoteDate: new Date("2026-08-13T06:00:00.000Z"),
      config: DEFAULT_QUOTATION_CONFIG,
      lines: [{ ...LINES[0], unit_price: null }],
      taxRefs: TAX_REFS,
      placeOfSupply: { stateCode: "05", label: "Uttarakhand (05)" },
      dealer: { name: "Himadri Enterprises", gstin: null },
    });
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].rate).toBe(0);
    expect(view.lines[0].amount).toBe(0);
  });

  it("adds the model id under the name only when the name omits it", () => {
    const view = buildQuotationView({
      quoteNumber: "ITQ-2026-0006",
      quoteDate: new Date("2026-08-13T06:00:00.000Z"),
      config: DEFAULT_QUOTATION_CONFIG,
      lines: [
        { ...LINES[0], product_name: "Trontek Pack", model_id: "TRO-51-105" },
        { ...LINES[1], product_name: "Charger TRO-CHG-48-25", model_id: "TRO-CHG-48-25" },
      ],
      taxRefs: TAX_REFS,
      placeOfSupply: { stateCode: "05", label: "Uttarakhand (05)" },
      dealer: { name: "Himadri Enterprises", gstin: null },
    });
    expect(view.lines[0].descriptionNote).toBe("Model: TRO-51-105");
    expect(view.lines[1].descriptionNote).toBeNull();
  });

  it("names the dealer explicitly when the lead has none", () => {
    const view = buildQuotationView({
      quoteNumber: "ITQ-2026-0007",
      quoteDate: new Date("2026-08-13T06:00:00.000Z"),
      config: DEFAULT_QUOTATION_CONFIG,
      lines: LINES,
      taxRefs: TAX_REFS,
      placeOfSupply: { stateCode: null, label: null },
      dealer: { name: null, gstin: null },
    });
    expect(view.billTo.name).toBe("(dealer name not recorded)");
    // No place of supply -> inter-state, per computeTotals' conservative default.
    expect(view.isIntraState).toBe(false);
  });
});

describe("config", () => {
  it("derives the seller state code from the GSTIN", () => {
    expect(stateCodeFromGstin("06AALFI7813E1ZE")).toBe("06");
    expect(stateCodeFromGstin("XX123")).toBeNull();
    expect(stateCodeFromGstin(null)).toBeNull();
  });

  it("re-derives the state code when a patch changes the GSTIN", () => {
    const merged = mergeQuotationConfig({ seller: { gstin: "27ABCDE1234F1Z5" } });
    expect(merged.seller.stateCode).toBe("27"); // Maharashtra
    // Untouched fields keep the default.
    expect(merged.seller.legalName).toBe("ITARANG TECHNOLOGIES LLP");
  });

  it("falls back to defaults on a malformed patch instead of throwing", () => {
    expect(mergeQuotationConfig(null)).toEqual(DEFAULT_QUOTATION_CONFIG);
    expect(mergeQuotationConfig("nonsense")).toEqual(DEFAULT_QUOTATION_CONFIG);
    expect(mergeQuotationConfig({ terms: [1, 2] }).terms).toEqual(
      DEFAULT_QUOTATION_CONFIG.terms,
    );
  });

  it("lets a patch override the document title and number prefix", () => {
    const merged = mergeQuotationConfig({
      documentTitle: "Quotation",
      numberPrefix: "ITQX",
    });
    expect(merged.documentTitle).toBe("Quotation");
    expect(merged.numberPrefix).toBe("ITQX");
  });
});

describe("formatQuoteDate", () => {
  it("renders IST, not UTC", () => {
    // 2026-08-13T19:00Z is already 14 Aug in IST.
    expect(formatQuoteDate(new Date("2026-08-13T19:00:00.000Z"))).toBe("14/08/2026");
  });
});

describe("the line-item table's column headers", () => {
  it("heads the tax columns GST and the line total Sub Total", () => {
    const out = renderProformaHtml(itpi35View());
    expect(out).toContain("<th class=\"num\">GST %</th>");
    expect(out).toContain("<th class=\"num\">GST Amt</th>");
    // "Amount" until 2026-08-20. The column IS the line's pre-tax sub-total and
    // now says so, next to a GST column that would otherwise look additive.
    expect(out).toContain("<th class=\"num\">Sub Total</th>");
    expect(out).not.toContain("<th class=\"num\">Amount</th>");
  });
});

describe("the Bill To block", () => {
  function billTo(dealer: Parameters<typeof buildQuotationView>[0]["dealer"]) {
    return buildQuotationView({
      quoteNumber: "ITQ-2026-0009",
      quoteDate: new Date("2026-08-13T06:00:00.000Z"),
      config: DEFAULT_QUOTATION_CONFIG,
      lines: LINES,
      taxRefs: TAX_REFS,
      placeOfSupply: { stateCode: "06", label: "Haryana (06)" },
      dealer,
    });
  }

  it("prints the lead's name, address and mobile", () => {
    const view = billTo({
      name: "Komal Enterprises ( Panipat) Nitish",
      gstin: null,
      addressLines: composeBillToAddress({
        area: "Model Town",
        location: "Panipat",
        city: "Panipat",
        state: "Haryana",
        pincode: "132103",
      }),
      phone: "+917419005078",
    });
    expect(view.billTo.name).toBe("Komal Enterprises ( Panipat) Nitish");
    // "Panipat" is the city AND the free-text location; it prints once.
    expect(view.billTo.addressLines).toEqual([
      "Model Town",
      "Panipat, Haryana 132103",
    ]);
    expect(view.billTo.phone).toBe("+917419005078");

    const out = renderProformaHtml(view);
    expect(out).toContain("Model Town");
    expect(out).toContain("Panipat, Haryana 132103");
    expect(out).toContain("Mobile +917419005078");
  });

  it("prints no mobile line at all when the lead has no phone", () => {
    const view = billTo({ name: "No Phone Traders", gstin: null, phone: "  " });
    expect(view.billTo.phone).toBeNull();
    expect(renderProformaHtml(view)).not.toContain("Mobile");
  });

  it("escapes the mobile like every other Bill To field", () => {
    const view = billTo({
      name: "Injection Traders",
      gstin: null,
      phone: '<script>alert(1)</script>',
    });
    expect(renderProformaHtml(view)).not.toContain("<script>");
  });
});

describe("composeBillToAddress", () => {
  it("returns nothing when the lead has no address at all", () => {
    expect(composeBillToAddress({})).toEqual([]);
    expect(
      composeBillToAddress({ city: "  ", state: null, pincode: "" }),
    ).toEqual([]);
  });

  it("drops a location that only repeats the city, whatever the case", () => {
    expect(
      composeBillToAddress({ location: "panipat", city: "Panipat", state: "Haryana" }),
    ).toEqual(["Panipat, Haryana"]);
  });

  it("keeps a PIN even when nothing else resolves", () => {
    expect(composeBillToAddress({ pincode: "132103" })).toEqual(["132103"]);
  });
});
