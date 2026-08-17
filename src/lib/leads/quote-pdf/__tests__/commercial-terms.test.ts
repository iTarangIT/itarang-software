/**
 * The deal's own terms on the document, and the letterhead mark.
 *
 * Both were entered by a rep or bundled with the app and then went nowhere:
 * credit period, warranty and delivery were stored on every commercials row and
 * printed on nothing, so a dealer received a proforma invoice that omitted the
 * terms the quote was agreed on.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_QUOTATION_CONFIG } from "../config";
import { renderProformaHtml } from "../proforma-template";
import { buildQuotationView } from "../view";
import type { BuildQuotationViewInput } from "../view";

const LINE = {
  asset_type: "battery" as const,
  product_id: "p1",
  product_name: "44.4V109AH KKP",
  model_id: "BAT-53V-178-3w",
  unit_price: 51_000,
  quantity: 1,
};

function view(over: Partial<BuildQuotationViewInput> = {}) {
  return buildQuotationView({
    quoteNumber: "ITQ-2026-0001",
    quoteDate: new Date("2026-08-17T06:00:00.000Z"),
    config: DEFAULT_QUOTATION_CONFIG,
    lines: [LINE],
    taxRefs: new Map([["battery:p1", { hsnCode: "85076000", gstRatePct: 18 }]]),
    placeOfSupply: { stateCode: "27", label: "Maharashtra (27)" },
    dealer: { name: "Aditya Tile Test", gstin: null },
    ...over,
  });
}

const ALL_TERMS = {
  paymentMethod: "cash",
  creditTerms: "120",
  deliveryTerms: "12",
  warranty: "24",
  dealNotes: "Two units to follow next quarter.",
};

describe("buildQuotationView — commercial terms", () => {
  it("carries every term the rep entered", () => {
    expect(view({ commercialTerms: ALL_TERMS }).commercialTerms).toEqual(ALL_TERMS);
  });

  it("defaults to all-null when the caller passes none", () => {
    expect(view().commercialTerms).toEqual({
      paymentMethod: null,
      creditTerms: null,
      deliveryTerms: null,
      warranty: null,
      dealNotes: null,
    });
  });

  it("treats blank and whitespace as never-entered", () => {
    // A row reading "Warranty: " looks like a term that was agreed and lost.
    const v = view({ commercialTerms: { warranty: "   ", creditTerms: "" } });
    expect(v.commercialTerms.warranty).toBeNull();
    expect(v.commercialTerms.creditTerms).toBeNull();
  });

  it("does not touch the totals", () => {
    expect(view({ commercialTerms: ALL_TERMS }).total).toBe(view().total);
  });
});

describe("renderProformaHtml — terms block", () => {
  it("prints each term the rep set", () => {
    const html = renderProformaHtml(view({ commercialTerms: ALL_TERMS }));
    expect(html).toContain("Terms Of This Quotation");
    expect(html).toContain("Payment");
    expect(html).toContain("cash");
    expect(html).toContain("Credit period");
    expect(html).toContain("120");
    expect(html).toContain("Warranty");
    expect(html).toContain("Two units to follow next quarter.");
  });

  it("omits the whole block when no term was entered", () => {
    // A quote raised before these were carried on the document must render
    // exactly as it did — no empty box, no stray dashes.
    const html = renderProformaHtml(view());
    expect(html).not.toContain("Terms Of This Quotation");
    // The class always ships in the stylesheet; what must be absent is markup
    // using it.
    expect(html).not.toContain('class="dealterms"');
    expect(html).not.toContain('class="dealterm"');
  });

  it("omits only the rows that are unset", () => {
    const html = renderProformaHtml(view({ commercialTerms: { warranty: "24" } }));
    expect(html).toContain("Terms Of This Quotation");
    expect(html).toContain("Warranty");
    expect(html).not.toContain("Credit period");
  });

  it("escapes a term rather than interpolating it as markup", () => {
    const html = renderProformaHtml(
      view({ commercialTerms: { dealNotes: '<img src=x onerror="alert(1)">' } }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("keeps the standing small print separate from this deal's terms", () => {
    const html = renderProformaHtml(view({ commercialTerms: ALL_TERMS }));
    // Both blocks present, and the static one still says what it always said.
    expect(html).toContain("Terms Of This Quotation");
    expect(html).toContain("Subject to Gurugram jurisdiction.");
  });
});

describe("renderProformaHtml — letterhead logo", () => {
  it("prints no image by default — the document leads with the legal name", () => {
    const html = renderProformaHtml(view());
    expect(html).not.toContain('class="logo"');
    expect(html).toContain("ITARANG TECHNOLOGIES LLP");
  });

  const withLogo = (uri: string | null) =>
    renderProformaHtml(
      view({
        config: {
          ...DEFAULT_QUOTATION_CONFIG,
          seller: { ...DEFAULT_QUOTATION_CONFIG.seller, logoDataUri: uri },
        },
      }),
    );

  it("draws the mark when one is configured", () => {
    const html = withLogo("data:image/png;base64,iVBORw0KGgo=");
    expect(html).toContain('class="logo"');
    expect(html).toContain("data:image/png;base64,iVBORw0KGgo=");
  });

  it("prints no image tag at all when there is none", () => {
    expect(withLogo(null)).not.toContain('class="logo"');
  });

  it("stays self-contained — the logo is inlined, never fetched", () => {
    // renderPdfFromHtml waits on domcontentloaded with no base URL, so a
    // remote or relative image would render broken on a document already sent.
    const html = withLogo("data:image/png;base64,iVBORw0KGgo=");
    const imgs = html.match(/<img[^>]+src="([^"]*)"/g) ?? [];
    expect(imgs.length).toBeGreaterThan(0);
    for (const tag of imgs) expect(tag).toContain('src="data:');
  });

  it("keeps the company name even when the logo is present", () => {
    // The mark is not a substitute for the legal name on a tax document.
    expect(withLogo("data:image/png;base64,iVBORw0KGgo=")).toContain(
      "ITARANG TECHNOLOGIES LLP",
    );
  });
});

describe("renderProformaHtml — signature block", () => {
  const SIG = "data:image/png;base64,c2lnbmF0dXJl";

  const withConfig = (over: Partial<typeof DEFAULT_QUOTATION_CONFIG>) =>
    renderProformaHtml(view({ config: { ...DEFAULT_QUOTATION_CONFIG, ...over } }));

  it("prints NOTHING by default — no name, no rule, no caption, no image", () => {
    // The shipped decision (2026-08-17): a quotation is an offer, and signing
    // one before the dealer has accepted anything says more than it means to.
    const html = renderProformaHtml(view());
    expect(html).not.toContain('class="sign"');
    expect(html).not.toContain('class="signimg"');
    expect(html).not.toContain("Authorized Signature");
    expect(html).not.toContain("Chirag Garg");
  });

  it("prints a typed block when a signatory IS configured", () => {
    // The capability survives the decision — it is one app_settings row away.
    const html = withConfig({ signatory: "A Person" });
    expect(html).toContain('class="signrule"');
    expect(html).toContain("A Person");
    expect(html).toContain("Authorized Signature");
  });

  it("prints a scanned block when one is configured, and drops the caption", () => {
    // A scan carries its own company line and title; printing "Authorized
    // Signature" under it would give one signatory two titles.
    const html = withConfig({ signatory: "A Person", signatureDataUri: SIG });
    expect(html).toContain('class="signimg"');
    expect(html).toContain(SIG);
    expect(html).toContain('alt="A Person"');
    expect(html).not.toContain('class="signrule"');
    expect(html).not.toContain("Authorized Signature");
  });
});
