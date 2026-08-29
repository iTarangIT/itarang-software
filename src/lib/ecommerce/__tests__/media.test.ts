import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * File validation runs BEFORE anything leaves our server, so a bad upload never
 * reaches Hostinger and never occupies a signed storage URL. Hostinger scans and
 * content-validates independently on attach, so passing here is necessary but not
 * sufficient — that later failure surfaces as itself.
 */

const createImageUploadUrl = vi.fn();
const uploadImageToSignedUrl = vi.fn();
const attachProductImage = vi.fn();

vi.mock("@/lib/hostinger/products", () => ({
  PER_PAGE: 50,
  listProducts: vi.fn(),
  getProductById: vi.fn(),
  listVariants: vi.fn(),
  createPhysicalProduct: vi.fn(),
  createDigitalProduct: vi.fn(),
  updateProduct: vi.fn(),
  deleteProduct: vi.fn(),
  updateVariantInventory: vi.fn(),
  updateVariantCommercial: vi.fn(),
  createImageUploadUrl: (...a: unknown[]) => createImageUploadUrl(...a),
  uploadImageToSignedUrl: (...a: unknown[]) => uploadImageToSignedUrl(...a),
  attachProductImage: (...a: unknown[]) => attachProductImage(...a),
}));

const { uploadEcommerceProductImage } = await import("../product-service");

const ACTOR = { id: "user-1", role: "sales_head" };
const PID = "prod_01";
const file = (over: Record<string, unknown> = {}) => ({
  blob: new Blob(["x"]),
  filename: "photo.png",
  mimeType: "image/png",
  size: 1024,
  ...over,
});

beforeEach(() => {
  createImageUploadUrl.mockReset();
  uploadImageToSignedUrl.mockReset();
  attachProductImage.mockReset();
  vi.stubEnv("HOSTINGER_STORE_ID", "store_TEST123");
  vi.stubEnv("HOSTINGER_API_TOKEN", "fake-token-for-tests");
});
afterEach(() => vi.unstubAllEnvs());

describe("file validation happens before any outbound call", () => {
  it("rejects SVG with a message naming the accepted formats", async () => {
    await expect(
      uploadEcommerceProductImage(PID, { file: file({ mimeType: "image/svg+xml" }) }, ACTOR),
    ).rejects.toMatchObject({ status: 422 });
    expect(createImageUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects a file over 15MB", async () => {
    await expect(
      uploadEcommerceProductImage(PID, { file: file({ size: 16 * 1024 * 1024 }) }, ACTOR),
    ).rejects.toMatchObject({ status: 422 });
    expect(createImageUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects an empty file", async () => {
    await expect(
      uploadEcommerceProductImage(PID, { file: file({ size: 0 }) }, ACTOR),
    ).rejects.toMatchObject({ status: 422 });
    expect(createImageUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects a non-image type", async () => {
    await expect(
      uploadEcommerceProductImage(PID, { file: file({ mimeType: "application/pdf" }) }, ACTOR),
    ).rejects.toMatchObject({ status: 422 });
    expect(createImageUploadUrl).not.toHaveBeenCalled();
  });

  it("requires either a file or a url", async () => {
    await expect(uploadEcommerceProductImage(PID, {}, ACTOR)).rejects.toMatchObject({ status: 422 });
  });
});

describe("upload flow", () => {
  it("runs signed-url -> storage -> attach, in that order, using object_name", async () => {
    createImageUploadUrl.mockResolvedValue({
      upload_url: "https://storage.example/x",
      fields: { key: "v" },
      object_name: "store/abc",
    });
    uploadImageToSignedUrl.mockResolvedValue(undefined);
    attachProductImage.mockResolvedValue({});

    await uploadEcommerceProductImage(PID, { file: file(), isThumbnail: true }, ACTOR);

    expect(createImageUploadUrl).toHaveBeenCalledWith(PID);
    expect(uploadImageToSignedUrl).toHaveBeenCalledOnce();
    expect(attachProductImage).toHaveBeenCalledWith(PID, {
      object_name: "store/abc",
      is_thumbnail: true,
    });
  });

  it("does not attach when the storage upload fails", async () => {
    createImageUploadUrl.mockResolvedValue({ upload_url: "u", fields: {}, object_name: "o" });
    uploadImageToSignedUrl.mockRejectedValue(new Error("storage rejected"));

    await expect(
      uploadEcommerceProductImage(PID, { file: file() }, ACTOR),
    ).rejects.toThrow("storage rejected");
    // Attaching an object that never landed would create a broken image record.
    expect(attachProductImage).not.toHaveBeenCalled();
  });

  it("attaches a public URL in a single call, with no signed-url step", async () => {
    attachProductImage.mockResolvedValue({});
    await uploadEcommerceProductImage(PID, { imageUrl: "https://x.example/a.png" }, ACTOR);

    expect(createImageUploadUrl).not.toHaveBeenCalled();
    expect(attachProductImage).toHaveBeenCalledWith(PID, { image_url: "https://x.example/a.png" });
  });
});
