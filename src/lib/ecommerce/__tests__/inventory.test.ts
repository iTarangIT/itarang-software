import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Inventory writes are ABSOLUTE, so a retry cannot double-count — but an absolute
 * write silently discards whatever moved between the operator reading a figure and
 * submitting it. `expectedQuantity` is the guard, and these tests pin the two
 * behaviours that make it worth having:
 *
 *   · a drifted value must BLOCK the write, not merge with it;
 *   · `prices` must never appear in an inventory payload, because the batch
 *     endpoint replaces a variant's prices in full.
 */

const listVariants = vi.fn();
const updateVariantInventory = vi.fn();

vi.mock("@/lib/hostinger/products", () => ({
  PER_PAGE: 50,
  listProducts: vi.fn(),
  getProductById: vi.fn(),
  createPhysicalProduct: vi.fn(),
  createDigitalProduct: vi.fn(),
  updateProduct: vi.fn(),
  updateVariantCommercial: vi.fn(),
  listVariants: (...a: unknown[]) => listVariants(...a),
  updateVariantInventory: (...a: unknown[]) => updateVariantInventory(...a),
}));

const { updateEcommerceVariantInventory, readVariantStock, StockDriftError } = await import(
  "../product-service"
);

const ACTOR = { id: "user-1", role: "sales_head" };
const VID = "variant_01";

const variant = (over: Record<string, unknown> = {}) => ({
  id: VID,
  title: "Default",
  sku: "SKU-1",
  options: [],
  prices: [{ amount: 100, sale_amount: null, currency_code: "inr" }],
  inventory_quantity: 4,
  manage_inventory: true,
  ...over,
});

beforeEach(() => {
  listVariants.mockReset();
  updateVariantInventory.mockReset();
  vi.stubEnv("HOSTINGER_STORE_ID", "store_TEST123");
  vi.stubEnv("HOSTINGER_API_TOKEN", "fake-token-for-tests");
});
afterEach(() => vi.unstubAllEnvs());

describe("readVariantStock", () => {
  it("reports null - not zero - for an untracked variant", async () => {
    listVariants.mockResolvedValue([variant({ manage_inventory: false, inventory_quantity: 0 })]);
    const s = await readVariantStock("prod_1", VID);
    expect(s.manageInventory).toBe(false);
    expect(s.quantity).toBeNull();
  });

  it("404s when the variant does not belong to the product", async () => {
    listVariants.mockResolvedValue([variant({ id: "variant_other" })]);
    await expect(readVariantStock("prod_1", VID)).rejects.toMatchObject({ status: 404 });
  });
});

describe("stock drift guard", () => {
  it("blocks the write when stock moved since the form was opened", async () => {
    listVariants.mockResolvedValue([variant({ inventory_quantity: 6 })]);

    await expect(
      updateEcommerceVariantInventory("prod_1", { variantId: VID, quantity: 10, expectedQuantity: 4 }, ACTOR),
    ).rejects.toBeInstanceOf(StockDriftError);

    // The critical assertion: nothing was sent to Hostinger.
    expect(updateVariantInventory).not.toHaveBeenCalled();
  });

  it("surfaces the current value so the operator can re-decide", async () => {
    listVariants.mockResolvedValue([variant({ inventory_quantity: 6 })]);
    try {
      await updateEcommerceVariantInventory(
        "prod_1", { variantId: VID, quantity: 10, expectedQuantity: 4 }, ACTOR,
      );
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as InstanceType<typeof StockDriftError>).details).toEqual({ currentQuantity: 6 });
      expect((e as Error).message).toContain("6");
    }
  });

  it("writes when the value has not moved", async () => {
    listVariants.mockResolvedValue([variant({ inventory_quantity: 4 })]);
    updateVariantInventory.mockResolvedValue({});
    await updateEcommerceVariantInventory(
      "prod_1", { variantId: VID, quantity: 10, expectedQuantity: 4 }, ACTOR,
    );
    expect(updateVariantInventory).toHaveBeenCalledOnce();
  });

  it("does not drift-check when switching tracking ON, which has no prior value", async () => {
    listVariants.mockResolvedValue([variant({ manage_inventory: false, inventory_quantity: 0 })]);
    updateVariantInventory.mockResolvedValue({});
    await updateEcommerceVariantInventory(
      "prod_1", { variantId: VID, quantity: 5, manageInventory: true, expectedQuantity: 99 }, ACTOR,
    );
    expect(updateVariantInventory).toHaveBeenCalledOnce();
  });
});

describe("payload shape", () => {
  it("never sends prices in an inventory update", async () => {
    listVariants.mockResolvedValue([variant()]);
    updateVariantInventory.mockResolvedValue({});
    await updateEcommerceVariantInventory("prod_1", { variantId: VID, quantity: 12 }, ACTOR);

    const [, , fields] = updateVariantInventory.mock.calls[0];
    // The batch endpoint replaces prices in full; carrying them here would let a
    // stock edit delete a variant's other-currency prices.
    expect(fields).not.toHaveProperty("prices");
    expect(fields).toEqual({ quantity: 12, manageInventory: undefined });
  });

  it("returns the value read back from Hostinger, not the value requested", async () => {
    listVariants
      .mockResolvedValueOnce([variant({ inventory_quantity: 4 })])
      .mockResolvedValueOnce([variant({ inventory_quantity: 12 })]);
    updateVariantInventory.mockResolvedValue({});
    const after = await updateEcommerceVariantInventory("prod_1", { variantId: VID, quantity: 12 }, ACTOR);
    expect(after.quantity).toBe(12);
    expect(listVariants).toHaveBeenCalledTimes(2);
  });
});
