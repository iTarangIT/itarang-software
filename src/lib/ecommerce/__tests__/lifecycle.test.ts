import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Delete is the only irreversible action in this feature, and Hostinger's 200
 * does not prove the product is gone: a subscription product with active
 * subscribers is archived instead of deleted. Reporting "deleted" in that case
 * would send someone hunting for a product that is still on the books, so the
 * service reads back and reports what actually happened.
 */

const deleteProduct = vi.fn();
const getProductById = vi.fn();
const updateProduct = vi.fn();

vi.mock("@/lib/hostinger/products", () => ({
  PER_PAGE: 50,
  listProducts: vi.fn(),
  listVariants: vi.fn(),
  createPhysicalProduct: vi.fn(),
  createDigitalProduct: vi.fn(),
  updateVariantPrice: vi.fn(),
  updateVariantInventory: vi.fn(),
  getProductById: (...a: unknown[]) => getProductById(...a),
  deleteProduct: (...a: unknown[]) => deleteProduct(...a),
  updateProduct: (...a: unknown[]) => updateProduct(...a),
}));

const {
  deleteEcommerceProduct,
  archiveEcommerceProduct,
  restoreEcommerceProduct,
} = await import("../product-service");

const ACTOR = { id: "user-1", role: "sales_head" };
const PID = "prod_01";
const notFound = () => Object.assign(new Error("Product not found in Hostinger"), { status: 404 });

beforeEach(() => {
  deleteProduct.mockReset();
  getProductById.mockReset();
  updateProduct.mockReset();
  vi.stubEnv("HOSTINGER_STORE_ID", "store_TEST123");
  vi.stubEnv("HOSTINGER_API_TOKEN", "fake-token-for-tests");
});
afterEach(() => vi.unstubAllEnvs());

describe("deleteEcommerceProduct", () => {
  it("reports removed when the product is gone afterwards", async () => {
    deleteProduct.mockResolvedValue(undefined);
    getProductById.mockRejectedValue(notFound());

    const res = await deleteEcommerceProduct(PID, ACTOR);
    expect(res).toEqual({ productId: PID, removed: true, survivingStatus: undefined });
  });

  it("reports NOT removed, with the real status, when Hostinger archived it instead", async () => {
    deleteProduct.mockResolvedValue(undefined);
    getProductById.mockResolvedValue({ id: PID, status: "archived" });

    const res = await deleteEcommerceProduct(PID, ACTOR);
    // A 200 from DELETE is not proof. This is the case that would otherwise be
    // reported as a successful deletion.
    expect(res.removed).toBe(false);
    expect(res.survivingStatus).toBe("archived");
  });

  it("does not claim either outcome when the confirmation read fails", async () => {
    deleteProduct.mockResolvedValue(undefined);
    getProductById.mockRejectedValue(Object.assign(new Error("upstream down"), { status: 502 }));

    await expect(deleteEcommerceProduct(PID, ACTOR)).rejects.toMatchObject({ status: 502 });
  });

  it("propagates a failed delete without pretending to check", async () => {
    deleteProduct.mockRejectedValue(Object.assign(new Error("nope"), { status: 502 }));

    await expect(deleteEcommerceProduct(PID, ACTOR)).rejects.toMatchObject({ status: 502 });
    expect(getProductById).not.toHaveBeenCalled();
  });
});

describe("archive / restore", () => {
  it("archives via a status change", async () => {
    updateProduct.mockResolvedValue({});
    await archiveEcommerceProduct(PID, ACTOR);
    expect(updateProduct).toHaveBeenCalledWith(PID, { status: "archived" });
  });

  it("restores to DRAFT, never straight to published", async () => {
    updateProduct.mockResolvedValue({});
    await restoreEcommerceProduct(PID, ACTOR);
    // Restoring must not silently put a product back on sale.
    expect(updateProduct).toHaveBeenCalledWith(PID, { status: "draft" });
  });
});
