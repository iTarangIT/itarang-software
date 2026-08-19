import { describe, expect, it } from "vitest";
import { diffCommercials, summariseChanges } from "../commercialsDiff";
import type { CommercialsProductLine } from "../types";

const battery = (over: Partial<CommercialsProductLine> = {}): CommercialsProductLine => ({
  asset_type: "battery",
  product_id: "p1",
  product_name: "44.4V109AH KKP",
  model_id: "BAT-53V-178-3w",
  unit_price: 51_000,
  quantity: 1,
  ...over,
});

const version = (over: Record<string, unknown> = {}) =>
  ({
    price_quoted: null,
    final_price: "51000.00",
    payment_method: "cash",
    credit_terms: "120",
    delivery_terms: "12",
    warranty_terms: "24",
    deal_notes: null,
    product_lines: [battery()],
    ...over,
  }) as Parameters<typeof diffCommercials>[1];

describe("diffCommercials", () => {
  it("reports nothing for the first version — it is the baseline, not a change", () => {
    expect(diffCommercials(null, version())).toEqual([]);
  });

  it("reports nothing when a revision changed none of the diffed fields", () => {
    expect(diffCommercials(version(), version())).toEqual([]);
  });

  it("reports a price change with both figures formatted", () => {
    const changes = diffCommercials(
      version({ final_price: "40000.00" }),
      version({ final_price: "51000.00" }),
    );
    expect(changes).toEqual([
      { label: "Final price", from: "₹40,000", to: "₹51,000" },
    ]);
  });

  it("distinguishes 'was not set' from a value", () => {
    const [change] = diffCommercials(
      version({ warranty_terms: null }),
      version({ warranty_terms: "24" }),
    );
    // null, not "0" and not "—": the component decides how to print absence.
    expect(change).toEqual({ label: "Warranty", from: null, to: "24" });
  });

  it("treats blank and whitespace as never-set, so no phantom change appears", () => {
    expect(
      diffCommercials(version({ credit_terms: "" }), version({ credit_terms: "   " })),
    ).toEqual([]);
  });

  it("reports an added line", () => {
    const changes = diffCommercials(
      version({ product_lines: [battery()] }),
      version({
        product_lines: [
          battery(),
          battery({ product_id: "p2", product_name: "Charger 48V", asset_type: "charger" }),
        ],
      }),
    );
    expect(changes).toContainEqual({
      label: "Charger 48V",
      from: null,
      to: "× 1 @ ₹51,000",
    });
  });

  it("reports a removed line", () => {
    const changes = diffCommercials(
      version({ product_lines: [battery(), battery({ product_id: "p2", product_name: "Charger 48V" })] }),
      version({ product_lines: [battery()] }),
    );
    expect(changes).toContainEqual({
      label: "Charger 48V",
      from: "× 1 @ ₹51,000",
      to: null,
    });
  });

  it("reports a quantity change on a line that stayed", () => {
    const changes = diffCommercials(
      version({ product_lines: [battery({ quantity: 1 })] }),
      version({ product_lines: [battery({ quantity: 3 })] }),
    );
    expect(changes).toEqual([
      { label: "44.4V109AH KKP", from: "× 1 @ ₹51,000", to: "× 3 @ ₹51,000" },
    ]);
  });

  it("ignores a product rename — the catalogue moved, this quote did not", () => {
    const changes = diffCommercials(
      version({ product_lines: [battery({ product_name: "Old name" })] }),
      version({ product_lines: [battery({ product_name: "New name" })] }),
    );
    expect(changes).toEqual([]);
  });

  it("handles a line the rep left unpriced without printing a price", () => {
    const changes = diffCommercials(
      version({ product_lines: [] }),
      version({ product_lines: [battery({ unit_price: null, quantity: 2 })] }),
    );
    expect(changes).toEqual([
      { label: "44.4V109AH KKP", from: null, to: "× 2" },
    ]);
  });

  it("survives a malformed product_lines value rather than throwing", () => {
    const changes = diffCommercials(
      version({ product_lines: null }),
      version({ product_lines: undefined }),
    );
    expect(changes).toEqual([]);
  });

  it("reproduces the real sandbox case: v1 ₹40,000 → v2 ₹51,000", () => {
    const changes = diffCommercials(
      version({ final_price: "40000.00", product_lines: [battery({ unit_price: 40_000 })] }),
      version({ final_price: "51000.00", product_lines: [battery({ unit_price: 51_000 })] }),
    );
    expect(summariseChanges(changes)).toBe(
      "Final price ₹40,000 → ₹51,000 · 44.4V109AH KKP × 1 @ ₹40,000 → × 1 @ ₹51,000",
    );
  });
});

describe("summariseChanges", () => {
  it("is empty when nothing changed, so a row shows no badge at all", () => {
    expect(summariseChanges([])).toBe("");
  });

  it("caps the list and says how many it withheld", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      label: `F${i}`,
      from: "a",
      to: "b",
    }));
    expect(summariseChanges(many)).toBe("F0 a → b · F1 a → b · F2 a → b · +2 more");
  });

  it("prints an em dash for a value that was never set", () => {
    expect(summariseChanges([{ label: "Warranty", from: null, to: "24" }])).toBe(
      "Warranty — → 24",
    );
  });
});
