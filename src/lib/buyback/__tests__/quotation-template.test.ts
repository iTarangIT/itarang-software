/**
 * The quotation PDF is a pure template, so it tests like one: HTML in, HTML out.
 *
 * What is pinned here is the battery spec block — the part a scrap buyer prices
 * on. The template used to hand-roll that list, which is how it drifted from
 * every other surface; it now delegates to vendorLineMeta, and these tests hold
 * it to that: the spec reaches the page, its numerics are trimmed, and every
 * part is HTML-escaped on the way out.
 */

import { describe, expect, it } from "vitest";

import { renderQuotationHtml } from "../pdf/quotation-template";
import { toVendorQuotation } from "../serialize";
import type { VendorLineSource } from "../serialize";

// Typed as the serializer's own source, so an override of `null` — the case that
// matters here, a spec the dealer never declared — is expressible. Inferring the
// shape from the fixture would type every field as non-null and make exactly the
// undeclared-field test impossible to write.
const SPEC: VendorLineSource = {
  line_id: "line-1",
  quantity: 2,
  condition: "DEAD" as const,
  voltage: "62.00",
  ah: "33.00",
  ask_price: "3450.00",
  variant_type: "62V 33Ah Li-ion",
  brand: "Exide",
  chemistry: "LFP",
  form_factor: "prismatic",
  nominal_voltage: "62.00",
  nominal_ampere: "33.00",
  unit_weight_kg: "11.500",
  warranty_cycles: 800,
  functional_qty: 0,
  non_functional_qty: 2,
  iot_battery: false,
};

const render = (over: Partial<VendorLineSource> = {}) =>
  renderQuotationHtml({
    quotation: toVendorQuotation({
      quotation_no: "QTN-1037-1",
      pickup_city: "Pune",
      pickup_state: "MH",
      lines: [{ ...SPEC, ...over }],
    }),
    vendorName: "Abhishek Mandal",
  });

describe("renderQuotationHtml — battery spec", () => {
  it("states the chemistry and the kilograms a scrap buyer prices on", () => {
    const html = render();
    expect(html).toContain(
      "62V 33Ah Li-ion · Exide · LFP · Prismatic · 62V 33Ah nominal · " +
        "11.5 kg/unit · 23 kg total · 800 cycles rated · 2 non-working · Non-IOT",
    );
  });

  it("trims the trailing zeros postgres numerics arrive with", () => {
    const html = render();
    expect(html).not.toContain("62.00V");
    expect(html).not.toContain("11.500 kg");
  });

  it("omits a spec the dealer never declared instead of printing a dash", () => {
    const html = render({ brand: null, chemistry: null, form_factor: null });
    expect(html).not.toContain("· LFP");
    expect(html).toContain("62V 33Ah nominal");
  });

  it("escapes the spec — a brand is dealer-entered text, not markup", () => {
    const html = render({ brand: '<script>alert("x")</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
