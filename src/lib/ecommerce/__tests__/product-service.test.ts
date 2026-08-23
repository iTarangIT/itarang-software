import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { HostingerProductRow } from "@/lib/hostinger/types";

/**
 * Normalisation is the seam where Hostinger's envelope becomes something the
 * Sales Head UI renders. Three failure modes matter, and all are silent:
 *
 *   · an unmanaged variant reported as 0 stock — reads as "out of stock" in the
 *     UI when it actually means "Hostinger isn't tracking this at all";
 *   · `variants: null` (the default, since the payload is lean unless
 *     include[]=variants) treated as "no variants" — would zero out the counts;
 *   · a price scale slip — amounts are minor units, so a 100x error is one
 *     misplaced divide away.
 *
 * Fixtures mirror real payloads captured from the live store.
 */

const listProducts = vi.fn();
const getProductById = vi.fn();

vi.mock("@/lib/hostinger/products", () => ({
  PER_PAGE: 50,
  listProducts: (...a: unknown[]) => listProducts(...a),
  getProductById: (...a: unknown[]) => getProductById(...a),
}));

const { getEcommerceProductDetail, getEcommerceProductList } = await import(
  "../product-service"
);

/** Real shape: managed variant, stock 4. */
const MANAGED: HostingerProductRow = {
  id: "prod_01M07W8R9V3QPTKFDC9B63XZHM",
  title: "iTarang Lithium Battery 200Ah - 12V LiFePO4",
  status: "published",
  thumbnail: "https://cdn.example/thumb.png",
  type: "physical",
  variant_count: 1,
  price_range: { min: 100, max: 100, currency_code: "inr" },
  variants: [
    {
      id: "variant_01M07W8REJ33FDFZX1YGJSX3D0",
      title: "iTarang Lithium Battery 200Ah",
      sku: "ITR-BAT-LI-200",
      options: [],
      prices: [{ amount: 100, sale_amount: null, currency_code: "inr" }],
      inventory_quantity: 4,
      manage_inventory: true,
    },
  ],
  media: [{ url: "https://cdn.example/1.png", type: "image", is_thumbnail: true }],
};

/** Real shape: the combo product, which does not manage inventory. */
const UNMANAGED: HostingerProductRow = {
  id: "prod_01M07WD4XP42SYQ1E1C1FTXYSM",
  title: "iTarang 900VA Inverter + 150Ah Lithium Battery Combo",
  status: "published",
  thumbnail: null,
  type: "physical",
  variant_count: 1,
  price_range: { min: 100, max: 100, currency_code: "inr" },
  variants: [
    {
      id: "variant_01M07WD51VQ15T6B2JBJSANMZ0",
      title: "Combo",
      sku: "ITR-CMB-900-150",
      options: [],
      prices: [],
      inventory_quantity: 0,
      manage_inventory: false,
    },
  ],
  media: null,
};

/** Default lean list row — variants and media omitted unless include[] is sent. */
const LEAN: HostingerProductRow = {
  ...MANAGED,
  variants: null,
  media: null,
};

beforeEach(() => {
  listProducts.mockReset();
  getProductById.mockReset();
  // Detail builds the Hostinger dashboard deep-link from server config, so the
  // store id has to be present even though no request is made.
  vi.stubEnv("HOSTINGER_STORE_ID", "store_TEST123");
  vi.stubEnv("HOSTINGER_API_TOKEN", "fake-token-for-tests");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("variant inventory normalisation", () => {
  it("reports null - not zero - when the variant is not inventory-managed", async () => {
    getProductById.mockResolvedValue(UNMANAGED);
    const p = await getEcommerceProductDetail(UNMANAGED.id);

    expect(p.variants[0].manageInventory).toBe(false);
    expect(p.variants[0].inventoryQuantity).toBeNull();
    // The list column must not claim a total for an untracked product.
    expect(p.totalInventory).toBeNull();
  });

  it("preserves quantity for managed variants", async () => {
    getProductById.mockResolvedValue(MANAGED);
    const p = await getEcommerceProductDetail(MANAGED.id);

    expect(p.variants[0].inventoryQuantity).toBe(4);
    expect(p.totalInventory).toBe(4);
  });

  it("builds the Hostinger deep-link server-side from the store id", async () => {
    getProductById.mockResolvedValue(MANAGED);
    const p = await getEcommerceProductDetail(MANAGED.id);

    // Built here rather than in the browser so the store id never needs a
    // NEXT_PUBLIC_ variable.
    expect(p.adminUrl).toBe(
      `https://ecommerce.hostinger.com/store/store_TEST123/products/edit?product=${MANAGED.id}`,
    );
  });
});

describe("lean list rows", () => {
  it("keeps variant_count from the payload when variants were not included", async () => {
    listProducts.mockResolvedValue({
      data: [LEAN],
      meta: { current_page: 1, per_page: 50, total: 1 },
    });
    const res = await getEcommerceProductList({ page: 1 });

    // variants: null means "not loaded", NOT "this product has no variants".
    expect(res.rows[0].variantCount).toBe(1);
    expect(res.rows[0].totalInventory).toBeNull();
    // SKU comes off the variant, so it is unavailable on a lean row.
    expect(res.rows[0].sku).toBeNull();
  });
});

describe("summary shaping", () => {
  it("exposes the SKU only for single-variant products", async () => {
    listProducts.mockResolvedValue({
      data: [MANAGED],
      meta: { current_page: 1, per_page: 50, total: 1 },
    });
    const res = await getEcommerceProductList({ page: 1 });

    expect(res.rows[0].sku).toBe("ITR-BAT-LI-200");
    expect(res.rows[0].type).toBe("physical");
    expect(res.rows[0].status).toBe("published");
  });

  it("carries paging straight from the vendor meta rather than assuming it", async () => {
    listProducts.mockResolvedValue({
      data: [],
      meta: { current_page: 3, per_page: 50, total: 120 },
    });
    const res = await getEcommerceProductList({ page: 3 });

    expect(res.page).toBe(3);
    expect(res.perPage).toBe(50);
    expect(res.total).toBe(120);
  });

  it("maps price_range in minor units without rescaling", async () => {
    listProducts.mockResolvedValue({
      data: [MANAGED],
      meta: { current_page: 1, per_page: 50, total: 1 },
    });
    const res = await getEcommerceProductList({ page: 1 });

    // 100 paise. Rescaling here would double-apply the divide in formatPrice.
    expect(res.rows[0].priceRange).toEqual({
      minMinor: 100,
      maxMinor: 100,
      currencyCode: "inr",
    });
  });
});
