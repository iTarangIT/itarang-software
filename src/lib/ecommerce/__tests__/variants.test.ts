import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Options, selections and variants (Phase 8B).
 *
 * Three vendor behaviours are pinned here, because each one is a trap the API
 * does not stop you falling into:
 *
 *  1. There is no option resource. Options exist only as the `{name, value}`
 *     pairs on variants, so they are DERIVED — `deriveOptions` is the only
 *     definition of what a product's options are.
 *  2. Variant creation is the one and only chance to set `sku` and `options`;
 *     the batch endpoint 400s on `options` and silently ignores `sku`.
 *  3. Hostinger will happily delete a product's LAST variant, leaving a
 *     published product with no price and no stock. The guard is ours.
 */

const listVariants = vi.fn();
const createVariant = vi.fn();
const deleteVariant = vi.fn();

vi.mock("@/lib/hostinger/products", () => ({
  PER_PAGE: 50,
  listProducts: vi.fn(),
  getProductById: vi.fn(),
  createPhysicalProduct: vi.fn(),
  createDigitalProduct: vi.fn(),
  updateProduct: vi.fn(),
  deleteProduct: vi.fn(),
  updateVariantInventory: vi.fn(),
  updateVariantCommercial: vi.fn(),
  createImageUploadUrl: vi.fn(),
  uploadImageToSignedUrl: vi.fn(),
  attachProductImage: vi.fn(),
  listVariants: (...a: unknown[]) => listVariants(...a),
  createVariant: (...a: unknown[]) => createVariant(...a),
  deleteVariant: (...a: unknown[]) => deleteVariant(...a),
}));

const { createEcommerceVariant, deleteEcommerceVariant, deriveOptions, LastVariantError } =
  await import("../product-service");

const ACTOR = { id: "user-1", role: "sales_head" };

/** A variant in the shape Hostinger returns. */
const hv = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id,
  sku: null,
  options: [],
  prices: [{ amount: 100, sale_amount: null, currency_code: "inr" }],
  inventory_quantity: 0,
  manage_inventory: false,
  ...over,
});

/** A variant after `toVariant` — the shape deriveOptions consumes. */
const ev = (id: string, options: { name: string; value: string }[]) => ({
  id,
  title: id,
  sku: null,
  inventoryQuantity: null,
  manageInventory: false,
  price: null,
  options,
});

beforeEach(() => {
  listVariants.mockReset();
  createVariant.mockReset();
  deleteVariant.mockReset();
  vi.stubEnv("HOSTINGER_STORE_ID", "store_TEST123");
  vi.stubEnv("HOSTINGER_API_TOKEN", "fake-token-for-tests");
});
afterEach(() => vi.unstubAllEnvs());

const sentBody = () => createVariant.mock.calls[0][1];

describe("deriveOptions", () => {
  it("collects distinct selections per option, in first-appearance order", () => {
    const options = deriveOptions([
      ev("v1", [{ name: "Size", value: "M" }, { name: "Colour", value: "Red" }]),
      ev("v2", [{ name: "Size", value: "L" }, { name: "Colour", value: "Red" }]),
      ev("v3", [{ name: "Size", value: "M" }, { name: "Colour", value: "Blue" }]),
    ]);

    // Order follows the order Hostinger reports the pairs in, not alphabetical.
    expect(options.map((o) => o.name)).toEqual(["Size", "Colour"]);
    expect(options[0].selections).toEqual(["M", "L"]); // "M" not repeated
    expect(options[1].selections).toEqual(["Red", "Blue"]);
  });

  it("flags Hostinger's backfilled placeholder so the UI can explain it", () => {
    const options = deriveOptions([
      ev("v1", [{ name: "Size", value: "Default Value" }]),
      ev("v2", [{ name: "Size", value: "M" }]),
    ]);

    expect(options[0].hasPlaceholder).toBe(true);
    expect(options[0].selections).toContain("Default Value");
  });

  it("reports no placeholder when every selection is a real one", () => {
    const options = deriveOptions([ev("v1", [{ name: "Size", value: "M" }])]);
    expect(options[0].hasPlaceholder).toBe(false);
  });

  it("returns nothing for a product whose variants carry no options", () => {
    expect(deriveOptions([ev("v1", []), ev("v2", [])])).toEqual([]);
  });
});

describe("createEcommerceVariant", () => {
  it("refuses an empty option list before calling Hostinger", async () => {
    // Upstream answers 422 "The options field is required."; failing here says why.
    await expect(createEcommerceVariant("prod_1", { options: [] }, ACTOR)).rejects.toThrow(
      /at least one option/i,
    );
    expect(createVariant).not.toHaveBeenCalled();
  });

  it("sends sku at creation — the only moment it can ever be set", async () => {
    createVariant.mockResolvedValue(hv("variant_1", { sku: "SKU-M" }));
    await createEcommerceVariant(
      "prod_1",
      { options: [{ name: "Size", value: "M" }], sku: "SKU-M", amountMinor: 250000 },
      ACTOR,
    );
    expect(sentBody().sku).toBe("SKU-M");
  });

  it("omits sku entirely when none was given", async () => {
    createVariant.mockResolvedValue(hv("variant_1"));
    await createEcommerceVariant("prod_1", { options: [{ name: "Size", value: "M" }] }, ACTOR);
    expect(sentBody()).not.toHaveProperty("sku");
  });

  it("carries the discount in the create call — no follow-up update needed", async () => {
    createVariant.mockResolvedValue(hv("variant_1"));
    await createEcommerceVariant(
      "prod_1",
      { options: [{ name: "Size", value: "M" }], amountMinor: 250000, saleAmountMinor: 199900 },
      ACTOR,
    );
    expect(sentBody().prices).toEqual([{ amount: 250000, currency: "inr", sale_amount: 199900 }]);
  });

  it("omits sale_amount rather than nulling it when there is no discount", async () => {
    createVariant.mockResolvedValue(hv("variant_1"));
    await createEcommerceVariant(
      "prod_1",
      { options: [{ name: "Size", value: "M" }], amountMinor: 250000 },
      ACTOR,
    );
    // The API rejects sale_amount: null ("must be an integer").
    expect(sentBody().prices[0]).not.toHaveProperty("sale_amount");
  });

  it("sends no prices key at all when no price was given", async () => {
    createVariant.mockResolvedValue(hv("variant_1"));
    await createEcommerceVariant("prod_1", { options: [{ name: "Size", value: "M" }] }, ACTOR);
    expect(sentBody()).not.toHaveProperty("prices");
  });

  it("lower-cases the currency and defaults it to inr", async () => {
    createVariant.mockResolvedValue(hv("variant_1"));
    await createEcommerceVariant(
      "prod_1",
      { options: [{ name: "Size", value: "M" }], amountMinor: 500, currency: "USD" },
      ACTOR,
    );
    expect(sentBody().prices[0].currency).toBe("usd");

    createVariant.mockClear();
    await createEcommerceVariant(
      "prod_1",
      { options: [{ name: "Size", value: "M" }], amountMinor: 500 },
      ACTOR,
    );
    expect(sentBody().prices[0].currency).toBe("inr");
  });

  it("never sends a title, so Hostinger's own naming applies", async () => {
    createVariant.mockResolvedValue(hv("variant_1"));
    await createEcommerceVariant(
      "prod_1",
      { options: [{ name: "Size", value: "M" }, { name: "Colour", value: "Red" }] },
      ACTOR,
    );
    // Left to Hostinger so CRM-created variants read the same as dashboard-created
    // ones ("M", "M / Red").
    expect(sentBody()).not.toHaveProperty("title");
  });

  it("returns the created variant in CRM shape", async () => {
    createVariant.mockResolvedValue(
      hv("variant_1", {
        title: "M",
        sku: "SKU-M",
        options: [{ name: "Size", value: "M" }],
        prices: [{ amount: 250000, sale_amount: 199900, currency_code: "inr" }],
        inventory_quantity: 7,
        manage_inventory: true,
      }),
    );

    const created = await createEcommerceVariant(
      "prod_1",
      { options: [{ name: "Size", value: "M" }], sku: "SKU-M" },
      ACTOR,
    );

    expect(created).toMatchObject({
      id: "variant_1",
      title: "M",
      sku: "SKU-M",
      inventoryQuantity: 7,
      manageInventory: true,
      options: [{ name: "Size", value: "M" }],
    });
    expect(created.price?.amountMinor).toBe(250000);
    expect(created.price?.saleAmountMinor).toBe(199900);
  });
});

describe("deleteEcommerceVariant", () => {
  it("refuses to delete the product's only variant", async () => {
    listVariants.mockResolvedValue([hv("variant_1")]);

    await expect(deleteEcommerceVariant("prod_1", "variant_1", ACTOR)).rejects.toBeInstanceOf(
      LastVariantError,
    );
    // The API would have allowed it, leaving a published product with no price.
    expect(deleteVariant).not.toHaveBeenCalled();
  });

  it("rejects a variant that is not on this product", async () => {
    listVariants.mockResolvedValue([hv("variant_1"), hv("variant_2")]);

    await expect(deleteEcommerceVariant("prod_1", "variant_other", ACTOR)).rejects.toThrow(
      /not found/i,
    );
    expect(deleteVariant).not.toHaveBeenCalled();
  });

  it("deletes and reports the remaining count from a fresh read", async () => {
    listVariants
      .mockResolvedValueOnce([hv("variant_1"), hv("variant_2")])
      .mockResolvedValueOnce([hv("variant_2")]);
    deleteVariant.mockResolvedValue(undefined);

    const result = await deleteEcommerceVariant("prod_1", "variant_1", ACTOR);

    expect(deleteVariant).toHaveBeenCalledWith("prod_1", "variant_1");
    // Read back rather than assuming the count decremented.
    expect(result).toEqual({ remaining: 1 });
  });

  it("re-reads the count at delete time rather than trusting the caller", async () => {
    // A sibling deleted concurrently must still trip the last-variant guard.
    listVariants.mockResolvedValue([hv("variant_1")]);

    await expect(deleteEcommerceVariant("prod_1", "variant_1", ACTOR)).rejects.toBeInstanceOf(
      LastVariantError,
    );
    expect(listVariants).toHaveBeenCalledWith("prod_1");
  });
});
