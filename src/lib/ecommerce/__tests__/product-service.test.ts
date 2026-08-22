import { describe, expect, it, vi, beforeEach } from "vitest";

import type { HostingerProduct } from "@/lib/hostinger/types";

/**
 * Normalisation is the seam where Hostinger's envelope becomes something the
 * Sales Head UI renders. Two failure modes matter, and both are silent:
 *
 *   · an unmanaged variant reported as 0 stock — reads as "out of stock" in the
 *     UI when it actually means "Hostinger isn't tracking this at all";
 *   · a dropped allow_backorder flag — hides that Hostinger will accept orders
 *     below zero, which is the one thing stopping someone assuming the platform
 *     will refuse an oversell.
 *
 * Fixtures below mirror real payloads captured from the live store during the
 * read-only Phase 1 probe.
 */

const listProducts = vi.fn();
const getProduct = vi.fn();

vi.mock("@/lib/hostinger/products", () => ({
  MAX_PAGE_SIZE: 100,
  listProducts: (...a: unknown[]) => listProducts(...a),
  getProduct: (...a: unknown[]) => getProduct(...a),
}));

const { getEcommerceProductDetail, getEcommerceProductList } = await import(
  "../product-service"
);

/** Real shape: a managed variant with stock 4 and backorder enabled. */
const MANAGED: HostingerProduct = {
  id: "prod_01M07W8R9V3QPTKFDC9B63XZHM",
  title: "iTarang Lithium Battery 200Ah - 12V LiFePO4",
  subtitle: "Longer backup for bigger loads",
  status: "published",
  updated_at: "2026-08-19T00:30:21.887Z",
  type: { value: "physical" },
  variants: [
    {
      id: "variant_01M07W8REJ33FDFZX1YGJSX3D0",
      title: "iTarang Lithium Battery 200Ah",
      image_url: null,
      sku: "ITR-BAT-LI-200",
      inventory_quantity: 4,
      allow_backorder: true,
      manage_inventory: true,
      track_low_stock: false,
      low_stock_threshold: null,
      is_active: true,
      prices: [
        {
          id: "ma_1",
          currency_code: "inr",
          currency: { code: "inr", symbol: "₹", decimal_digits: 2 },
          amount: 100,
          sale_amount: null,
          region_id: null,
        },
      ],
    },
  ],
};

/** Real shape: the combo product, which does not manage inventory. */
const UNMANAGED: HostingerProduct = {
  id: "prod_01M07WD4XP42SYQ1E1C1FTXYSM",
  title: "iTarang 900VA Inverter + 150Ah Lithium Battery Combo",
  status: "published",
  variants: [
    {
      id: "variant_01M07WD51VQ15T6B2JBJSANMZ0",
      title: "Combo",
      image_url: null,
      sku: "ITR-CMB-900-150",
      manage_inventory: false,
      inventory_quantity: 0,
      allow_backorder: false,
      is_active: true,
      prices: [],
    },
  ],
};

beforeEach(() => {
  listProducts.mockReset();
  getProduct.mockReset();
});

describe("variant inventory normalisation", () => {
  it("reports null - not zero - when the variant is not inventory-managed", async () => {
    getProduct.mockResolvedValue(UNMANAGED);
    const p = await getEcommerceProductDetail(UNMANAGED.id);

    expect(p.variants[0].manageInventory).toBe(false);
    expect(p.variants[0].inventoryQuantity).toBeNull();
    // The list column must not claim a total for an untracked product.
    expect(p.totalInventory).toBeNull();
  });

  it("preserves quantity and the backorder flag for managed variants", async () => {
    getProduct.mockResolvedValue(MANAGED);
    const p = await getEcommerceProductDetail(MANAGED.id);

    expect(p.variants[0].inventoryQuantity).toBe(4);
    expect(p.variants[0].allowBackorder).toBe(true);
    expect(p.totalInventory).toBe(4);
    expect(p.anyBackorder).toBe(true);
  });
});

describe("summary shaping", () => {
  it("exposes the SKU only for single-variant products", async () => {
    listProducts.mockResolvedValue({
      products: [MANAGED],
      count: 1,
      offset: 0,
      limit: 25,
    });
    const res = await getEcommerceProductList({ limit: 25, offset: 0 });

    expect(res.rows[0].sku).toBe("ITR-BAT-LI-200");
    expect(res.rows[0].variantCount).toBe(1);
    expect(res.rows[0].type).toBe("physical");
    expect(res.total).toBe(1);
  });

  it("carries the raw price amount and its scale rather than a formatted string", async () => {
    getProduct.mockResolvedValue(MANAGED);
    const p = await getEcommerceProductDetail(MANAGED.id);

    // The price scale is not yet confirmed with Hostinger, so the service must
    // hand the UI the source number and let it disclose the raw value.
    expect(p.variants[0].price?.amountMinor).toBe(100);
    expect(p.variants[0].price?.decimalDigits).toBe(2);
    expect(p.variants[0].price?.currencyCode).toBe("inr");
  });

  it("defaults decimal digits to 2 when the currency omits them", async () => {
    getProduct.mockResolvedValue({
      ...MANAGED,
      variants: [
        {
          ...MANAGED.variants![0],
          prices: [
            {
              id: "ma_2",
              currency_code: "inr",
              // decimal_digits absent
              currency: { code: "inr", symbol: "₹" } as never,
              amount: 4999900,
              sale_amount: null,
              region_id: null,
            },
          ],
        },
      ],
    });
    const p = await getEcommerceProductDetail(MANAGED.id);

    // Guessing 0 would render paise as rupees and overstate by 100x.
    expect(p.variants[0].price?.decimalDigits).toBe(2);
  });
});
