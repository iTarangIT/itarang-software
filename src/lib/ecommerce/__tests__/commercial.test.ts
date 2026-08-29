import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The batch endpoint REPLACES a variant's prices in full. That makes a price edit
 * quietly destructive on a multi-currency variant unless the untouched currencies
 * are carried over — which is the defect this path exists to avoid.
 *
 * Also pinned here: `sale_amount: null` is rejected by the API, so clearing a
 * discount means omitting the key, not nulling it.
 */

const listVariants = vi.fn();
const updateVariantCommercial = vi.fn();

vi.mock("@/lib/hostinger/products", () => ({
  PER_PAGE: 50,
  listProducts: vi.fn(),
  getProductById: vi.fn(),
  createPhysicalProduct: vi.fn(),
  createDigitalProduct: vi.fn(),
  updateProduct: vi.fn(),
  deleteProduct: vi.fn(),
  updateVariantInventory: vi.fn(),
  createImageUploadUrl: vi.fn(),
  uploadImageToSignedUrl: vi.fn(),
  attachProductImage: vi.fn(),
  listVariants: (...a: unknown[]) => listVariants(...a),
  updateVariantCommercial: (...a: unknown[]) => updateVariantCommercial(...a),
}));

const { updateEcommerceVariantCommercial } = await import("../product-service");

const ACTOR = { id: "user-1", role: "sales_head" };
const VID = "variant_01";

const withPrices = (prices: unknown[]) => [
  { id: VID, title: "Default", sku: "SKU-1", options: [], prices, manage_inventory: true, inventory_quantity: 4 },
];

beforeEach(() => {
  listVariants.mockReset();
  updateVariantCommercial.mockReset();
  vi.stubEnv("HOSTINGER_STORE_ID", "store_TEST123");
  vi.stubEnv("HOSTINGER_API_TOKEN", "fake-token-for-tests");
});
afterEach(() => vi.unstubAllEnvs());

const sentFields = () => updateVariantCommercial.mock.calls[0][2];

describe("multi-currency safety", () => {
  it("carries untouched currencies through a price edit", async () => {
    listVariants.mockResolvedValue(
      withPrices([
        { amount: 100, sale_amount: null, currency_code: "inr" },
        { amount: 500, sale_amount: null, currency_code: "usd" },
      ]),
    );
    updateVariantCommercial.mockResolvedValue({});

    await updateEcommerceVariantCommercial(
      "prod_1", { variantId: VID, amountMinor: 250000, currency: "inr" }, ACTOR,
    );

    const prices = sentFields().prices;
    // Without this, the full-replace would delete the USD price outright.
    expect(prices).toHaveLength(2);
    expect(prices).toContainEqual({ amount: 250000, currency: "inr" });
    expect(prices).toContainEqual({ amount: 500, currency: "usd" });
  });

  it("preserves an existing discount on a currency it is not changing", async () => {
    listVariants.mockResolvedValue(
      withPrices([
        { amount: 100, sale_amount: null, currency_code: "inr" },
        { amount: 500, sale_amount: 400, currency_code: "usd" },
      ]),
    );
    updateVariantCommercial.mockResolvedValue({});

    await updateEcommerceVariantCommercial(
      "prod_1", { variantId: VID, amountMinor: 900, currency: "inr" }, ACTOR,
    );

    expect(sentFields().prices).toContainEqual({ amount: 500, currency: "usd", sale_amount: 400 });
  });
});

describe("discount handling", () => {
  it("sets a discount alongside the price", async () => {
    listVariants.mockResolvedValue(withPrices([{ amount: 1000, sale_amount: null, currency_code: "inr" }]));
    updateVariantCommercial.mockResolvedValue({});

    await updateEcommerceVariantCommercial(
      "prod_1", { variantId: VID, amountMinor: 2000, saleAmountMinor: 1500 }, ACTOR,
    );
    expect(sentFields().prices).toEqual([{ amount: 2000, currency: "inr", sale_amount: 1500 }]);
  });

  it("clears a discount by OMITTING sale_amount, never nulling it", async () => {
    listVariants.mockResolvedValue(withPrices([{ amount: 2000, sale_amount: 1500, currency_code: "inr" }]));
    updateVariantCommercial.mockResolvedValue({});

    await updateEcommerceVariantCommercial(
      "prod_1", { variantId: VID, saleAmountMinor: null }, ACTOR,
    );

    const price = sentFields().prices[0];
    // The API rejects sale_amount:null outright ("must be an integer").
    expect(price).not.toHaveProperty("sale_amount");
    expect(price.amount).toBe(2000); // price itself untouched
  });

  it("leaves an existing discount alone when only the price changes", async () => {
    listVariants.mockResolvedValue(withPrices([{ amount: 2000, sale_amount: 1500, currency_code: "inr" }]));
    updateVariantCommercial.mockResolvedValue({});

    await updateEcommerceVariantCommercial("prod_1", { variantId: VID, amountMinor: 3000 }, ACTOR);
    expect(sentFields().prices[0]).toEqual({ amount: 3000, currency: "inr", sale_amount: 1500 });
  });
});

describe("payload boundaries", () => {
  it("never sends sku — the batch endpoint silently ignores it", async () => {
    listVariants.mockResolvedValue(withPrices([{ amount: 100, sale_amount: null, currency_code: "inr" }]));
    updateVariantCommercial.mockResolvedValue({});
    await updateEcommerceVariantCommercial("prod_1", { variantId: VID, amountMinor: 200 }, ACTOR);

    // Verified 2026-08-24: `sku` alone 400s, and `sku` with prices returns 200
    // with the SKU unchanged. Sending it would report success while doing nothing.
    expect(sentFields()).not.toHaveProperty("sku");
  });

  it("never sends inventory fields", async () => {
    listVariants.mockResolvedValue(withPrices([{ amount: 100, sale_amount: null, currency_code: "inr" }]));
    updateVariantCommercial.mockResolvedValue({});
    await updateEcommerceVariantCommercial("prod_1", { variantId: VID, amountMinor: 200 }, ACTOR);

    expect(sentFields()).not.toHaveProperty("inventory_quantity");
    expect(sentFields()).not.toHaveProperty("manage_inventory");
  });
});
