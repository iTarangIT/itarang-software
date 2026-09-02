import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { HostingerVariant } from "@/lib/hostinger/types";

/**
 * Commercial values during New Product creation.
 *
 * `CreatePhysicalProductRequest` is exactly name, price, currency and description
 * — Hostinger's own OpenAPI document, confirmed by sending the extra keys and
 * watching all of them come back discarded. So everything else has to be written
 * afterwards, against the variant, which is what these tests pin:
 *
 *  · no option  → the auto-created variant is edited in place. It can take a
 *    discount and stock, never a SKU.
 *  · an option  → a real variant is created carrying the SKU, and Hostinger's
 *    placeholder variant is deleted afterwards.
 *
 * The rule that matters most is the one about fabrication: with no option from
 * the operator, nothing invents one, and no SKU is sent anywhere.
 */

const createPhysicalProduct = vi.fn();
const createDigitalProduct = vi.fn();
const updateProduct = vi.fn();
const listVariants = vi.fn();
const createVariant = vi.fn();
const deleteVariant = vi.fn();
const updateVariantCommercial = vi.fn();
const updateVariantInventory = vi.fn();

vi.mock("@/lib/hostinger/products", () => ({
  PER_PAGE: 50,
  listProducts: vi.fn(),
  getProductById: vi.fn(),
  deleteProduct: vi.fn(),
  createImageUploadUrl: vi.fn(),
  uploadImageToSignedUrl: vi.fn(),
  attachProductImage: vi.fn(),
  createPhysicalProduct: (...a: unknown[]) => createPhysicalProduct(...a),
  createDigitalProduct: (...a: unknown[]) => createDigitalProduct(...a),
  updateProduct: (...a: unknown[]) => updateProduct(...a),
  listVariants: (...a: unknown[]) => listVariants(...a),
  createVariant: (...a: unknown[]) => createVariant(...a),
  deleteVariant: (...a: unknown[]) => deleteVariant(...a),
  updateVariantCommercial: (...a: unknown[]) => updateVariantCommercial(...a),
  updateVariantInventory: (...a: unknown[]) => updateVariantInventory(...a),
}));

const { createEcommerceProduct } = await import("../product-service");

const ACTOR = { id: "user-1", role: "sales_head" };
const DEFAULT_VID = "variant_default";
const NEW_VID = "variant_new";

/** The base every case starts from: name + price only. */
const BASE = { kind: "physical" as const, name: "iTarang 150Ah", priceMinor: 250000, publish: true };

/** Hostinger's auto-created, option-less variant. */
const defaultVariant = (over: Partial<HostingerVariant> = {}): HostingerVariant => ({
  id: DEFAULT_VID,
  title: "Default",
  sku: null,
  options: [],
  prices: [{ amount: 250000, sale_amount: null, currency_code: "inr" }],
  inventory_quantity: 0,
  manage_inventory: false,
  ...over,
});

const createdVariant = (): HostingerVariant => ({
  id: NEW_VID,
  title: "150Ah",
  sku: "ITG-LB-150AH",
  options: [{ name: "Capacity", value: "150Ah" }],
  prices: [{ amount: 250000, sale_amount: null, currency_code: "inr" }],
  inventory_quantity: 0,
  manage_inventory: false,
});

/**
 * The variant list has to be modelled rather than stubbed flat: creating a
 * variant makes the product's list grow, and deleteEcommerceVariant re-reads that
 * list to enforce its last-variant guard. A constant fixture would make the guard
 * refuse a delete that is perfectly safe in reality.
 */
let variantRows: HostingerVariant[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HOSTINGER_STORE_ID", "store_TEST123");
  vi.stubEnv("HOSTINGER_API_TOKEN", "fake-token-for-tests");

  createPhysicalProduct.mockResolvedValue({
    product: { id: "prod_1", title: BASE.name, status: "published" },
    admin_url: "https://ecommerce.hostinger.com/store/store_TEST123/products/edit?product=prod_1",
  });

  variantRows = [defaultVariant()];
  listVariants.mockImplementation(async () => variantRows.slice());
  createVariant.mockImplementation(async () => {
    const v = createdVariant();
    variantRows.push(v);
    return v;
  });
  deleteVariant.mockImplementation(async (_productId: string, variantId: string) => {
    variantRows = variantRows.filter((v) => v.id !== variantId);
  });
  updateVariantCommercial.mockResolvedValue({});
  updateVariantInventory.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

/** Fields handed to the variant batch endpoint. */
const commercialFields = () => updateVariantCommercial.mock.calls[0][2];
/** Body handed to POST /variants. */
const createVariantBody = () => createVariant.mock.calls[0][1];

describe("plain creation", () => {
  it("makes no follow-up call when only name and price were given", async () => {
    const result = await createEcommerceProduct(BASE, ACTOR);

    expect(result.productId).toBe("prod_1");
    // Nothing to apply means nothing to read, either.
    expect(listVariants).not.toHaveBeenCalled();
    expect(updateVariantCommercial).not.toHaveBeenCalled();
    expect(updateVariantInventory).not.toHaveBeenCalled();
    expect(createVariant).not.toHaveBeenCalled();
    expect(result.setup).toBeUndefined();
  });

  it("sends only the four documented fields to the create endpoint", async () => {
    await createEcommerceProduct(
      { ...BASE, saleAmountMinor: 199900, options: [{ name: "Capacity", value: "150Ah" }], sku: "S" },
      ACTOR,
    );

    // Hostinger discards anything else here, so sending more would be theatre.
    expect(Object.keys(createPhysicalProduct.mock.calls[0][0]).sort()).toEqual(["name", "price"]);
  });
});

describe("discount price during creation", () => {
  it("applies the discount to the auto-created variant", async () => {
    const result = await createEcommerceProduct({ ...BASE, saleAmountMinor: 199900 }, ACTOR);

    expect(updateVariantCommercial).toHaveBeenCalledWith("prod_1", DEFAULT_VID, expect.anything());
    expect(commercialFields().prices).toEqual([
      { amount: 250000, currency: "inr", sale_amount: 199900 },
    ]);
    expect(result.setup).toMatchObject({ variantId: DEFAULT_VID, discountApplied: true });
    expect(result.setup?.failed).toBeUndefined();
  });

  it("leaves the price alone — only the sale amount is being added", async () => {
    await createEcommerceProduct({ ...BASE, saleAmountMinor: 199900 }, ACTOR);
    // The amount comes from the read-back, not from the create payload.
    expect(commercialFields().prices[0].amount).toBe(250000);
  });

  it("makes no pricing call when only stock was given", async () => {
    await createEcommerceProduct({ ...BASE, manageInventory: true, quantity: 5 }, ACTOR);
    // A stock write must never carry prices — the batch endpoint replaces them.
    expect(updateVariantCommercial).not.toHaveBeenCalled();
  });
});

describe("SKU during real-variant creation", () => {
  const WITH_OPTION = {
    ...BASE,
    sku: "ITG-LB-150AH",
    options: [{ name: "Capacity", value: "150Ah" }],
  };

  it("sends the SKU and the option to the variant endpoint", async () => {
    const result = await createEcommerceProduct(WITH_OPTION, ACTOR);

    expect(createVariantBody()).toMatchObject({
      sku: "ITG-LB-150AH",
      options: [{ name: "Capacity", value: "150Ah" }],
    });
    expect(result.setup).toMatchObject({
      variantId: NEW_VID,
      variantCreated: true,
      skuApplied: true,
    });
  });

  it("prices the real variant, since the placeholder it replaces is going away", async () => {
    await createEcommerceProduct({ ...WITH_OPTION, saleAmountMinor: 199900 }, ACTOR);

    expect(createVariantBody().prices).toEqual([
      { amount: 250000, currency: "inr", sale_amount: 199900 },
    ]);
    // One call carries everything — no follow-up edit.
    expect(updateVariantCommercial).not.toHaveBeenCalled();
  });

  it("deletes Hostinger's placeholder variant afterwards, never before", async () => {
    const result = await createEcommerceProduct(WITH_OPTION, ACTOR);

    expect(deleteVariant).toHaveBeenCalledWith("prod_1", DEFAULT_VID);
    expect(createVariant.mock.invocationCallOrder[0]).toBeLessThan(
      deleteVariant.mock.invocationCallOrder[0],
    );
    expect(result.setup?.defaultVariantRemoved).toBe(true);
  });

  it("keeps the placeholder when the real variant could not be created", async () => {
    createVariant.mockRejectedValue(new Error("422 options required"));

    const result = await createEcommerceProduct(WITH_OPTION, ACTOR);

    // Deleting it now would leave a published product with no variant at all.
    expect(deleteVariant).not.toHaveBeenCalled();
    expect(result.productId).toBe("prod_1");
    expect(result.setup?.failed).toEqual([
      { step: "variant-create", error: "422 options required" },
    ]);
  });
});

describe("no fake option is ever invented", () => {
  it("creates no variant and sends no SKU when the operator gave no option", async () => {
    await createEcommerceProduct({ ...BASE, saleAmountMinor: 199900 }, ACTOR);

    expect(createVariant).not.toHaveBeenCalled();
    expect(deleteVariant).not.toHaveBeenCalled();
    // The batch endpoint silently ignores sku, so sending it would report a
    // success that never happened.
    expect(commercialFields()).not.toHaveProperty("sku");
  });
});

describe("track quantity", () => {
  it("enabled with a quantity sets both fields on the variant", async () => {
    const result = await createEcommerceProduct(
      { ...BASE, manageInventory: true, quantity: 7 },
      ACTOR,
    );

    expect(updateVariantInventory).toHaveBeenCalledWith("prod_1", DEFAULT_VID, {
      quantity: 7,
      manageInventory: true,
    });
    expect(result.setup?.stockApplied).toBe(true);
  });

  it("enabled on the real-variant path travels in the create call", async () => {
    await createEcommerceProduct(
      {
        ...BASE,
        options: [{ name: "Capacity", value: "150Ah" }],
        manageInventory: true,
        quantity: 7,
      },
      ACTOR,
    );

    expect(createVariantBody()).toMatchObject({
      inventory_quantity: 7,
      manage_inventory: true,
    });
    expect(updateVariantInventory).not.toHaveBeenCalled();
  });

  it("disabled makes no inventory call at all", async () => {
    await createEcommerceProduct({ ...BASE, saleAmountMinor: 199900 }, ACTOR);

    // manage_inventory: false is already Hostinger's default; writing it would be
    // a call that changes nothing.
    expect(updateVariantInventory).not.toHaveBeenCalled();
  });
});

describe("partial failure keeps the product", () => {
  it("reports a failed stock write without discarding the created product", async () => {
    updateVariantInventory.mockRejectedValue(new Error("upstream 500"));

    const result = await createEcommerceProduct(
      { ...BASE, saleAmountMinor: 199900, manageInventory: true, quantity: 7 },
      ACTOR,
    );

    expect(result.productId).toBe("prod_1");
    // The discount landed before stock failed — say so, rather than implying
    // nothing happened and inviting a duplicate product.
    expect(result.setup?.discountApplied).toBe(true);
    expect(result.setup?.stockApplied).toBeUndefined();
    expect(result.setup?.failed).toEqual([{ step: "stock", error: "upstream 500" }]);
  });

  it("reports a variant read it could not make", async () => {
    listVariants.mockRejectedValue(new Error("upstream 503"));

    const result = await createEcommerceProduct({ ...BASE, saleAmountMinor: 199900 }, ACTOR);

    expect(result.productId).toBe("prod_1");
    expect(result.setup?.failed).toEqual([{ step: "read-variants", error: "upstream 503" }]);
    expect(updateVariantCommercial).not.toHaveBeenCalled();
  });
});
