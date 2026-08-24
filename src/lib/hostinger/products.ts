/**
 * Hostinger product operations (documented API v1).
 *
 * Reads: list + single-product lookup. Writes (Phase 5): create physical/digital,
 * partial product update, and variant price update. Delete is NOT here — it is
 * Phase 7.
 *
 * The documented write verbs are PATCH and DELETE; the server confirms this
 * itself, returning 405 "Supported methods: PATCH, DELETE." for any other verb
 * on a product. There is no PUT.
 */

import { HostingerApiError, hostingerDelete, hostingerGet, hostingerWrite } from "./client";
import type {
  HostingerCreateDigitalRequest,
  HostingerCreatePhysicalRequest,
  HostingerCreateResponse,
  HostingerProductListResponse,
  HostingerProductRow,
  HostingerProductStatus,
  HostingerUpdateProductRequest,
  HostingerVariant,
  HostingerVariantInventoryBatchRequest,
  HostingerVariantInventoryUpdate,
  HostingerVariantListResponse,
  HostingerAttachImageRequest,
  HostingerCreateVariantRequest,
  HostingerImageUploadUrlResponse,
  HostingerVariantCommercialUpdate,
} from "./types";

/**
 * The API fixes the page size at 50 and exposes no `per_page` parameter, so this
 * is the server's value rather than a client preference. It is echoed back in
 * `meta.per_page`; callers should prefer that over this constant where available.
 */
export const PER_PAGE = 50;

/** Opt-in heavy data. Without these, `variants` and `media` come back null. */
const FULL_INCLUDE = ["variants", "media"] as const;

export async function listProducts(params: {
  page: number;
  q?: string;
  status?: HostingerProductStatus[];
  /** Omit the heavy payload for a leaner list where variants aren't needed. */
  includeDetail?: boolean;
}): Promise<HostingerProductListResponse> {
  const res = await hostingerGet<HostingerProductListResponse>("/products", {
    page: params.page,
    q: params.q,
    status: params.status,
    include: params.includeDetail === false ? undefined : [...FULL_INCLUDE],
  });

  // Defensive: the envelope is the vendor's, so don't assume every key arrived.
  return {
    data: Array.isArray(res?.data) ? res.data : [],
    meta: {
      current_page: res?.meta?.current_page ?? params.page,
      per_page: res?.meta?.per_page ?? PER_PAGE,
      total: res?.meta?.total ?? 0,
    },
  };
}

/**
 * There is no single-product GET — the API returns 405 for it. The documented
 * substitute is the `product_ids` filter, which the reference describes as
 * "doubles as a single-product lookup".
 */
export async function getProductById(productId: string): Promise<HostingerProductRow> {
  const res = await hostingerGet<HostingerProductListResponse>("/products", {
    page: 1,
    product_ids: [productId],
    include: [...FULL_INCLUDE],
  });

  const row = res?.data?.[0];
  if (!row) {
    const err = new Error("Product not found in Hostinger") as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  return row;
}

/* ---------------------------------------------------------------------------
 * Writes (Phase 5). Create + update only — no delete (Phase 7), no inventory
 * (Phase 6).
 * ------------------------------------------------------------------------- */

/** Both create endpoints produce a PUBLISHED product; there is no status field. */
export async function createPhysicalProduct(
  body: HostingerCreatePhysicalRequest,
): Promise<HostingerCreateResponse> {
  return hostingerWrite<HostingerCreateResponse>("POST", "/products/physical", body);
}

export async function createDigitalProduct(
  body: HostingerCreateDigitalRequest,
): Promise<HostingerCreateResponse> {
  return hostingerWrite<HostingerCreateResponse>("POST", "/products/digital", body);
}

/** Partial update. Omitted keys are left untouched. */
export async function updateProduct(
  productId: string,
  body: HostingerUpdateProductRequest,
): Promise<unknown> {
  return hostingerWrite("PATCH", `/products/${encodeURIComponent(productId)}`, body);
}


/** Variants for one product. Used for the pre-write stock re-read. */
export async function listVariants(productId: string): Promise<HostingerVariant[]> {
  const res = await hostingerGet<HostingerVariantListResponse>(
    `/products/${encodeURIComponent(productId)}/variants`,
  );
  return Array.isArray(res?.data) ? res.data : [];
}

/**
 * Inventory only. Absolute — `quantity` is the resulting stock, not a delta, and
 * the write is idempotent (verified: setting 7 twice leaves 7).
 *
 * `prices` is never sent: the batch endpoint replaces a variant's prices in full,
 * so including them would let a stock edit disturb pricing.
 *
 * Note: setting manage_inventory=false does NOT clear inventory_quantity — the
 * stored figure survives and is simply ignored, so it will be stale if tracking
 * is switched back on. Callers should treat an untracked variant's quantity as
 * meaningless rather than current.
 */
export async function updateVariantInventory(
  productId: string,
  variantId: string,
  fields: { quantity?: number; manageInventory?: boolean },
): Promise<unknown> {
  const variant: HostingerVariantInventoryUpdate = { variant_id: variantId };
  if (fields.quantity !== undefined) variant.inventory_quantity = fields.quantity;
  if (fields.manageInventory !== undefined) variant.manage_inventory = fields.manageInventory;

  const body: HostingerVariantInventoryBatchRequest = { variants: [variant] };
  return hostingerWrite(
    "PATCH",
    `/products/${encodeURIComponent(productId)}/variants/batch`,
    body,
  );
}

/**
 * Permanent removal. Irreversible from the CRM: afterwards the product is absent
 * from every endpoint available to us, and there is no way to list deleted
 * products, so absence is the only confirmation obtainable.
 *
 * One documented exception — "a subscription product with active subscribers is
 * archived instead of deleted so its data stays available" — means a 200 here
 * does NOT prove the product is gone. Callers must read back rather than assume.
 */
export async function deleteProduct(productId: string): Promise<void> {
  await hostingerDelete(`/products/${encodeURIComponent(productId)}`);
}

/* ---------------------------------------------------------------------------
 * Product media (Phase 8A)
 * ------------------------------------------------------------------------- */

/** Step 1: ask Hostinger for a signed storage URL to upload into. */
export async function createImageUploadUrl(
  productId: string,
): Promise<HostingerImageUploadUrlResponse> {
  return hostingerWrite<HostingerImageUploadUrlResponse>(
    "POST",
    `/products/${encodeURIComponent(productId)}/images/upload-url`,
    {},
  );
}

/**
 * Step 2: push the bytes to the signed URL.
 *
 * This is NOT a Hostinger API call — it targets whatever storage host the signed
 * URL points at, so it deliberately sends NO Authorization header. Leaking our
 * Hostinger token to a third-party storage endpoint would be a real credential
 * exposure, and the signed URL is already the authorisation.
 *
 * `fields` must be appended verbatim and BEFORE the file, which is how signed
 * form uploads are specified.
 */
export async function uploadImageToSignedUrl(
  signed: HostingerImageUploadUrlResponse,
  file: Blob,
  filename: string,
): Promise<void> {
  const form = new FormData();
  for (const [k, v] of Object.entries(signed.fields ?? {})) form.append(k, v);
  form.append("file", file, filename);

  let res: Response;
  try {
    res = await fetch(signed.upload_url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000), // large files over a slow link
    });
  } catch (e: unknown) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    throw new HostingerApiError(
      timedOut ? "Image upload timed out" : "Could not reach the image storage host",
      504,
      null,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[hostinger] signed upload failed", {
      status: res.status,
      body: body.slice(0, 300),
    });
    throw new HostingerApiError(`Image storage rejected the upload (${res.status})`, 502, null);
  }
}

/**
 * Step 3 — or the whole thing, when attaching an image already public.
 * Hostinger virus-scans and content-validates here, so this can still fail on a
 * file that passed our own checks.
 */
export async function attachProductImage(
  productId: string,
  body: HostingerAttachImageRequest,
): Promise<unknown> {
  return hostingerWrite(
    "POST",
    `/products/${encodeURIComponent(productId)}/images`,
    body,
  );
}

/**
 * Prices on a variant, through the batch endpoint.
 *
 * SKU is NOT accepted here. The endpoint silently ignores it — `sku` alone 400s,
 * and `sku` with prices returns 200 with the SKU unchanged (verified). SKU is
 * only settable at variant creation.
 *
 * Inventory fields are deliberately absent so a price edit can never disturb
 * stock (the batch endpoint is partial; verified in Phase 5).
 */
export async function updateVariantCommercial(
  productId: string,
  variantId: string,
  fields: {
    title?: string;
    prices?: { amount: number; currency: string; sale_amount?: number }[];
  },
): Promise<unknown> {
  const variant: HostingerVariantCommercialUpdate = { variant_id: variantId };
  if (fields.title !== undefined) variant.title = fields.title;
  if (fields.prices !== undefined) variant.prices = fields.prices;

  return hostingerWrite(
    "PATCH",
    `/products/${encodeURIComponent(productId)}/variants/batch`,
    { variants: [variant] },
  );
}

/* ---------------------------------------------------------------------------
 * Variants (Phase 8B)
 * ------------------------------------------------------------------------- */

/**
 * Add a variant along one or more option dimensions.
 *
 * Creating a variant with an option name the product does not yet have CREATES
 * that dimension — and Hostinger then backfills `"Default Value"` for it onto
 * every pre-existing variant. Callers must warn before that happens; it cannot
 * be undone, as there is no endpoint to rename or remove a dimension.
 */
export async function createVariant(
  productId: string,
  body: HostingerCreateVariantRequest,
): Promise<HostingerVariant> {
  const res = await hostingerWrite<{ data?: HostingerVariant } & HostingerVariant>(
    "POST",
    `/products/${encodeURIComponent(productId)}/variants`,
    body,
  );
  // The create response has been seen both bare and wrapped; accept either
  // rather than assuming, since the vendor is inconsistent across endpoints.
  return (res as { data?: HostingerVariant }).data ?? (res as HostingerVariant);
}

/**
 * Delete one variant.
 *
 * The API permits deleting the LAST variant, leaving a published product with no
 * variants, no price and no stock. It will not stop you. The guard against that
 * lives in the service layer — see deleteEcommerceVariant.
 */
export async function deleteVariant(productId: string, variantId: string): Promise<void> {
  await hostingerDelete(
    `/products/${encodeURIComponent(productId)}/variants/${encodeURIComponent(variantId)}`,
  );
}
