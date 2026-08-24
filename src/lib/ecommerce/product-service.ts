/**
 * Ecommerce product service — normalises Hostinger's envelope into CRM view
 * types. READ-ONLY: list and detail only.
 *
 * Hostinger is the source of truth. Nothing here is cached, mirrored, or written
 * to the CRM database, and there is no correlation with the CRM's separate
 * physical `products` / `product_master_*` system.
 */

import { getHostingerConfig } from "@/lib/hostinger/client";
import {
  createDigitalProduct,
  createPhysicalProduct,
  deleteProduct,
  getProductById,
  listProducts,
  createVariant,
  deleteVariant,
  listVariants,
  updateProduct,
  updateVariantCommercial,
  updateVariantInventory,
  attachProductImage,
  createImageUploadUrl,
  uploadImageToSignedUrl,
} from "@/lib/hostinger/products";
import {
  HOSTINGER_IMAGE_MAX_BYTES,
  HOSTINGER_IMAGE_MIME_TYPES,
} from "@/lib/hostinger/types";
import type {
  HostingerCreateResponse,
  HostingerCreateVariantRequest,
  HostingerPrice,
  HostingerProductRow,
  HostingerProductStatus,
  HostingerVariant,
} from "@/lib/hostinger/types";
import { HOSTINGER_PLACEHOLDER_SELECTION } from "./types";
import type {
  EcommerceOption,
  EcommercePrice,
  EcommercePriceRange,
  EcommerceProductDetail,
  EcommerceProductListResult,
  EcommerceProductSummary,
  EcommerceVariant,
} from "./types";

function toPrice(p: HostingerPrice | undefined): EcommercePrice | null {
  if (!p) return null;
  return {
    amountMinor: typeof p.amount === "number" ? p.amount : null,
    saleAmountMinor: typeof p.sale_amount === "number" ? p.sale_amount : null,
    currencyCode: p.currency_code ?? "",
  };
}

function toPriceRange(row: HostingerProductRow): EcommercePriceRange | null {
  const r = row.price_range;
  if (!r) return null;
  return {
    minMinor: typeof r.min === "number" ? r.min : null,
    maxMinor: typeof r.max === "number" ? r.max : null,
    currencyCode: r.currency_code ?? "",
  };
}

function toVariant(v: HostingerVariant): EcommerceVariant {
  const manageInventory = v.manage_inventory === true;
  return {
    id: v.id,
    title: v.title ?? "",
    sku: v.sku ?? null,
    // Only meaningful when managed. Reporting 0 for an unmanaged variant would
    // read as "out of stock" when it actually means "stock not tracked".
    inventoryQuantity:
      manageInventory && typeof v.inventory_quantity === "number" ? v.inventory_quantity : null,
    manageInventory,
    price: toPrice(v.prices?.[0]),
    options: Array.isArray(v.options) ? v.options : [],
  };
}

function summarise(row: HostingerProductRow): EcommerceProductSummary {
  // `variants` is null unless include[]=variants was requested; treat that as
  // "not loaded" rather than "no variants", so the counts below stay honest.
  const variants = (row.variants ?? []).map(toVariant);
  const managed = variants.filter((v) => v.manageInventory && v.inventoryQuantity !== null);

  return {
    id: row.id,
    title: row.title ?? "",
    status: row.status ?? null,
    type: row.type ?? null,
    thumbnail: row.thumbnail ?? null,
    variantCount: typeof row.variant_count === "number" ? row.variant_count : variants.length,
    sku: variants.length === 1 ? (variants[0].sku ?? null) : null,
    totalInventory: managed.length
      ? managed.reduce((sum, v) => sum + (v.inventoryQuantity ?? 0), 0)
      : null,
    priceRange: toPriceRange(row),
  };
}

export async function getEcommerceProductList(params: {
  page: number;
  q?: string;
  status?: HostingerProductStatus[];
}): Promise<EcommerceProductListResult> {
  const res = await listProducts(params);
  return {
    rows: res.data.map(summarise),
    total: res.meta.total,
    page: res.meta.current_page,
    perPage: res.meta.per_page,
  };
}

export async function getEcommerceProductDetail(
  productId: string,
): Promise<EcommerceProductDetail> {
  const row = await getProductById(productId);
  const { storeId } = getHostingerConfig();
  const variants = (row.variants ?? []).map(toVariant);
  return {
    ...summarise(row),
    media: (row.media ?? []).map((m) => ({ url: m.url })),
    variants,
    options: deriveOptions(variants),
    // Same shape Hostinger returns as `admin_url` on create.
    adminUrl: `https://ecommerce.hostinger.com/store/${storeId}/products/edit?product=${row.id}`,
  };
}

/* ---------------------------------------------------------------------------
 * Writes (Phase 5)
 * ------------------------------------------------------------------------- */

/**
 * Structured log line for every mutation.
 *
 * This is NOT an audit trail and must not be mistaken for one: no CRM database
 * writes were authorised for this feature, so there is no `audit_logs` row and
 * no in-product history. What lands here is greppable in the PM2/Vercel logs and
 * nothing more — unqueryable, subject to log retention, invisible in the UI.
 * If "who changed this price" ever needs answering in-product, that is a
 * decision to revisit the audit question, not a reason to invent a table.
 */
function logMutation(entry: {
  action: string;
  actorId: string;
  actorRole: string;
  productId?: string;
  fields?: Record<string, unknown>;
  outcome: "ok" | "failed";
  correlationId?: string | null;
  error?: string;
}) {
  console.info("[ecommerce-mutation]", JSON.stringify(entry));
}

export interface EcommerceActor {
  id: string;
  role: string;
}

export interface CreateProductInput {
  kind: "physical" | "digital";
  name: string;
  priceMinor: number;
  description?: string;
  currency?: string;
  downloadUrl?: string;
  /** Draft is create + PATCH; see the partial-failure contract below. */
  publish: boolean;

  /* --- Commercial values applied after the product exists (see applyCreationExtras) --- */

  /** Discount price. Omit for none; the API rejects a null sale_amount. */
  saleAmountMinor?: number;
  /**
   * SKU. Only reachable when `options` is also given: `sku` exists solely on
   * CreateVariantRequest, which requires at least one option, and the variant
   * batch endpoint has no sku property at all. Callers must not invent an option
   * to unlock it — the route rejects a SKU without one.
   */
  sku?: string;
  /**
   * A real, operator-supplied option (e.g. Capacity / 150Ah). Its presence
   * switches creation onto the real-variant path.
   */
  options?: { name: string; value: string }[];
  quantity?: number;
  manageInventory?: boolean;
}

/**
 * What happened after the product itself was created.
 *
 * Every step here runs against a product that ALREADY EXISTS, so a failure must
 * name what did and did not land — reporting it as a failed create would invite a
 * retry and produce a second product.
 */
export interface CreateSetupResult {
  /** The variant that ended up carrying the commercial values. */
  variantId?: string;
  /** True when a real option-bearing variant was created (the SKU path). */
  variantCreated?: boolean;
  /** True once Hostinger's option-less placeholder variant has been removed. */
  defaultVariantRemoved?: boolean;
  discountApplied?: boolean;
  stockApplied?: boolean;
  skuApplied?: boolean;
  failed?: { step: string; error: string }[];
}

export interface CreateProductResult {
  productId: string;
  title: string;
  status: string;
  adminUrl: string;
  /**
   * True when the product was created but the follow-up status=draft PATCH
   * failed, leaving it PUBLISHED. The caller must say so explicitly — reporting
   * a generic failure would invite a retry that creates a second product.
   */
  draftFailed?: boolean;
  draftError?: string;
  /** Present only when the caller asked for a discount, SKU, option or stock. */
  setup?: CreateSetupResult;
}

export async function createEcommerceProduct(
  input: CreateProductInput,
  actor: EcommerceActor,
): Promise<CreateProductResult> {
  const body = {
    name: input.name,
    price: input.priceMinor,
    ...(input.currency ? { currency: input.currency } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.kind === "digital" && input.downloadUrl
      ? { download_url: input.downloadUrl }
      : {}),
  };

  let created: HostingerCreateResponse;
  try {
    created =
      input.kind === "digital"
        ? await createDigitalProduct(body)
        : await createPhysicalProduct(body);
  } catch (e) {
    logMutation({
      action: "product.create",
      actorId: actor.id,
      actorRole: actor.role,
      fields: { name: input.name, priceMinor: input.priceMinor, kind: input.kind },
      outcome: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  const productId = created.product.id;
  logMutation({
    action: "product.create",
    actorId: actor.id,
    actorRole: actor.role,
    productId,
    fields: { name: input.name, priceMinor: input.priceMinor, kind: input.kind },
    outcome: "ok",
  });

  const result: CreateProductResult = {
    productId,
    title: created.product.title,
    status: created.product.status,
    adminUrl: created.admin_url,
  };

  // Both create endpoints publish immediately — there is no status on create —
  // so "save as draft" is a second call, and it can fail on its own.
  if (!input.publish) {
    try {
      await updateProduct(productId, { status: "draft" });
      result.status = "draft";
      logMutation({
        action: "product.update",
        actorId: actor.id,
        actorRole: actor.role,
        productId,
        fields: { status: "draft" },
        outcome: "ok",
      });
    } catch (e) {
      result.draftFailed = true;
      result.draftError = e instanceof Error ? e.message : String(e);
      logMutation({
        action: "product.update",
        actorId: actor.id,
        actorRole: actor.role,
        productId,
        fields: { status: "draft" },
        outcome: "failed",
        error: result.draftError,
      });
    }
  }

  const setup = await applyCreationExtras(productId, input, actor);
  if (setup) result.setup = setup;

  return result;
}

/**
 * Applies the commercial values the create endpoints cannot carry.
 *
 * `CreatePhysicalProductRequest` is exactly name, price, currency and description
 * — verified against Hostinger's published OpenAPI document and by sending the
 * extra keys, which come back 201 with every one discarded. So discount, stock
 * and SKU all have to be written afterwards, against the variant.
 *
 * Two paths, decided by whether the operator named a real option:
 *
 *   A. No option — the auto-created variant is edited in place. It can take a
 *      discount and stock, but never a SKU: `sku` exists only on
 *      CreateVariantRequest, and that requires an option.
 *   B. An option — a real variant is created carrying everything including the
 *      SKU, then Hostinger's placeholder variant is deleted.
 *
 * Nothing here throws. The product already exists by this point, so every failure
 * is reported through `failed` instead — see CreateSetupResult.
 */
async function applyCreationExtras(
  productId: string,
  input: CreateProductInput,
  actor: EcommerceActor,
): Promise<CreateSetupResult | undefined> {
  const wantsVariant = !!input.options?.length;
  const wantsDiscount = input.saleAmountMinor !== undefined;
  const wantsStock = input.quantity !== undefined || input.manageInventory !== undefined;
  if (!wantsVariant && !wantsDiscount && !wantsStock) return undefined;

  const setup: CreateSetupResult = {};
  const fail = (step: string, e: unknown) => {
    (setup.failed ??= []).push({ step, error: e instanceof Error ? e.message : String(e) });
  };

  // Needed by both paths: the target in A, the placeholder to remove in B.
  let defaultVariantId: string | undefined;
  try {
    defaultVariantId = (await listVariants(productId))[0]?.id;
  } catch (e) {
    fail("read-variants", e);
    return setup;
  }
  if (!defaultVariantId) {
    fail("read-variants", new Error("The new product came back with no variant to write to"));
    return setup;
  }

  if (wantsVariant) {
    let created: EcommerceVariant;
    try {
      created = await createEcommerceVariant(
        productId,
        {
          options: input.options!,
          ...(input.sku ? { sku: input.sku } : {}),
          // The price given at creation belongs to the placeholder variant, which
          // is about to go, so the real variant has to be priced here too.
          amountMinor: input.priceMinor,
          ...(input.saleAmountMinor !== undefined
            ? { saleAmountMinor: input.saleAmountMinor }
            : {}),
          ...(input.currency ? { currency: input.currency } : {}),
          ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
          ...(input.manageInventory !== undefined
            ? { manageInventory: input.manageInventory }
            : {}),
        },
        actor,
      );
    } catch (e) {
      // The placeholder is deliberately left alone — deleting it now would leave
      // a published product with no variant at all.
      fail("variant-create", e);
      return setup;
    }

    setup.variantId = created.id;
    setup.variantCreated = true;
    setup.skuApplied = !!input.sku;
    setup.discountApplied = wantsDiscount;
    setup.stockApplied = wantsStock;

    // Last, and separately reported: until it lands the product simply has an
    // extra variant, which is recoverable from the product page.
    try {
      await deleteEcommerceVariant(productId, defaultVariantId, actor);
      setup.defaultVariantRemoved = true;
    } catch (e) {
      fail("placeholder-delete", e);
    }

    return setup;
  }

  setup.variantId = defaultVariantId;

  if (wantsDiscount) {
    try {
      // Re-reads the prices and replaces only this currency, so the batch
      // endpoint's full-replace cannot drop another one.
      await updateEcommerceVariantCommercial(
        productId,
        {
          variantId: defaultVariantId,
          saleAmountMinor: input.saleAmountMinor,
          ...(input.currency ? { currency: input.currency } : {}),
        },
        actor,
      );
      setup.discountApplied = true;
    } catch (e) {
      fail("discount", e);
    }
  }

  if (wantsStock) {
    try {
      // No expectedQuantity: the variant is seconds old, so there is nothing for
      // a drift check to compare against.
      await updateEcommerceVariantInventory(
        productId,
        {
          variantId: defaultVariantId,
          ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
          ...(input.manageInventory !== undefined
            ? { manageInventory: input.manageInventory }
            : {}),
        },
        actor,
      );
      setup.stockApplied = true;
    } catch (e) {
      fail("stock", e);
    }
  }

  return setup;
}

export async function updateEcommerceProduct(
  productId: string,
  fields: { name?: string; status?: "draft" | "published" | "archived" },
  actor: EcommerceActor,
): Promise<void> {
  try {
    // `description` is deliberately never sent: the API can write it but offers
    // no way to read it, so including it would overwrite the live value with
    // whatever the blank form held.
    await updateProduct(productId, fields);
  } catch (e) {
    logMutation({
      action: "product.update",
      actorId: actor.id,
      actorRole: actor.role,
      productId,
      fields,
      outcome: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
  logMutation({
    action: "product.update",
    actorId: actor.id,
    actorRole: actor.role,
    productId,
    fields,
    outcome: "ok",
  });
}


/** Current tracked state of one variant, for the pre-write drift check. */
export interface VariantStock {
  variantId: string;
  quantity: number | null;
  manageInventory: boolean;
}

export async function readVariantStock(
  productId: string,
  variantId: string,
): Promise<VariantStock> {
  const variants = await listVariants(productId);
  const v = variants.find((x) => x.id === variantId);
  if (!v) {
    const err = new Error("Variant not found on this product") as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const manageInventory = v.manage_inventory === true;
  return {
    variantId: v.id,
    // Null when untracked, so callers cannot mistake "not tracked" for zero.
    quantity:
      manageInventory && typeof v.inventory_quantity === "number" ? v.inventory_quantity : null,
    manageInventory,
  };
}

/** Raised when stock moved between the operator reading it and submitting. */
export class StockDriftError extends Error {
  readonly status = 409;
  readonly currentQuantity: number | null;
  /** withErrorHandler forwards `details` alongside the message (api-utils.ts). */
  readonly details: { currentQuantity: number | null };
  constructor(expected: number, current: number | null) {
    super(
      `Stock changed from ${expected} to ${current ?? "untracked"} since this form was opened. Nothing was written — review the current value and submit again.`,
    );
    this.name = "StockDriftError";
    this.currentQuantity = current;
    this.details = { currentQuantity: current };
  }
}

export async function updateEcommerceVariantInventory(
  productId: string,
  input: {
    variantId: string;
    quantity?: number;
    manageInventory?: boolean;
    /**
     * What the operator saw when the form loaded. Absolute writes cannot
     * double-count, but they DO silently discard anything that moved in between,
     * so the value is re-checked immediately before writing.
     */
    expectedQuantity?: number;
  },
  actor: EcommerceActor,
): Promise<VariantStock> {
  const before = await readVariantStock(productId, input.variantId);

  // Only meaningful when the variant is already tracked; switching tracking ON
  // has no prior quantity to drift from.
  if (
    input.expectedQuantity !== undefined &&
    before.manageInventory &&
    before.quantity !== input.expectedQuantity
  ) {
    logMutation({
      action: "variant.inventory.update",
      actorId: actor.id,
      actorRole: actor.role,
      productId,
      fields: { ...input, blockedBy: "stock-drift", actual: before.quantity },
      outcome: "failed",
    });
    throw new StockDriftError(input.expectedQuantity, before.quantity);
  }

  try {
    await updateVariantInventory(productId, input.variantId, {
      quantity: input.quantity,
      manageInventory: input.manageInventory,
    });
  } catch (e) {
    logMutation({
      action: "variant.inventory.update",
      actorId: actor.id,
      actorRole: actor.role,
      productId,
      fields: { ...input },
      outcome: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  // Read back rather than echoing the request, so the UI shows what Hostinger
  // actually holds instead of what we hoped it would.
  const after = await readVariantStock(productId, input.variantId);
  logMutation({
    action: "variant.inventory.update",
    actorId: actor.id,
    actorRole: actor.role,
    productId,
    fields: { ...input, from: before.quantity, to: after.quantity },
    outcome: "ok",
  });
  return after;
}

/**
 * Outcome of a delete attempt.
 *
 * `removed: false` is not a failure — Hostinger archives a subscription product
 * with active subscribers instead of deleting it, so a 200 does not prove the
 * product is gone. The read-back is what turns a 200 into a truthful answer.
 */
export interface DeleteProductResult {
  productId: string;
  removed: boolean;
  /** The status it is now in, when it survived the delete. */
  survivingStatus?: string | null;
}

export async function deleteEcommerceProduct(
  productId: string,
  actor: EcommerceActor,
): Promise<DeleteProductResult> {
  try {
    await deleteProduct(productId);
  } catch (e) {
    logMutation({
      action: "product.delete",
      actorId: actor.id,
      actorRole: actor.role,
      productId,
      outcome: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  // Read back rather than trusting the 200. Reporting "deleted" for a product
  // that is actually still there would send someone hunting for something that
  // is still on the books.
  let removed = true;
  let survivingStatus: string | null | undefined;
  try {
    const still = await getProductById(productId);
    removed = false;
    survivingStatus = still.status ?? null;
  } catch (e) {
    // A 404 here is the expected, successful case.
    const status = (e as { status?: number }).status;
    if (status !== 404) {
      // The delete itself succeeded; only the confirmation read failed. Say so
      // rather than claiming either outcome.
      logMutation({
        action: "product.delete",
        actorId: actor.id,
        actorRole: actor.role,
        productId,
        outcome: "ok",
        error: `delete succeeded but read-back failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      const err = new Error(
        "The product was deleted but the confirmation check failed. Refresh the list to see whether it is gone.",
      ) as Error & { status?: number };
      err.status = 502;
      throw err;
    }
  }

  logMutation({
    action: "product.delete",
    actorId: actor.id,
    actorRole: actor.role,
    productId,
    fields: { removed, survivingStatus },
    outcome: "ok",
  });

  return { productId, removed, survivingStatus };
}

/** Retire a product. Reversible — see restoreEcommerceProduct. */
export async function archiveEcommerceProduct(
  productId: string,
  actor: EcommerceActor,
): Promise<void> {
  await updateEcommerceProduct(productId, { status: "archived" }, actor);
}

/**
 * Bring an archived product back as a DRAFT, never straight to published.
 * Restoring should not silently put something back on sale — publishing stays a
 * separate, deliberate step.
 */
export async function restoreEcommerceProduct(
  productId: string,
  actor: EcommerceActor,
): Promise<void> {
  await updateEcommerceProduct(productId, { status: "draft" }, actor);
}

/* ---------------------------------------------------------------------------
 * Product media + variant commercial fields (Phase 8A)
 * ------------------------------------------------------------------------- */

export interface UploadImageInput {
  /** Raw file bytes, when uploading from the operator's machine. */
  file?: { blob: Blob; filename: string; mimeType: string; size: number };
  /** Alternative: an already-public image Hostinger can fetch itself. */
  imageUrl?: string;
  isThumbnail?: boolean;
}

/**
 * Validates before anything leaves our server, so a bad file never reaches
 * Hostinger. Their attach step scans and content-validates independently, so a
 * file passing these checks can still be refused there — that failure surfaces
 * as itself rather than as a generic "upload failed".
 */
function assertUploadable(file: NonNullable<UploadImageInput["file"]>) {
  const bad = (msg: string) => {
    const err = new Error(msg) as Error & { status?: number };
    err.status = 422;
    throw err;
  };
  if (file.size > HOSTINGER_IMAGE_MAX_BYTES) {
    bad(`Image is too large — the maximum is ${HOSTINGER_IMAGE_MAX_BYTES / (1024 * 1024)} MB.`);
  }
  if (file.size === 0) bad("The file is empty.");
  if (!(HOSTINGER_IMAGE_MIME_TYPES as readonly string[]).includes(file.mimeType)) {
    // SVG is called out because it is the one people reach for and Hostinger
    // explicitly refuses it.
    bad(
      file.mimeType === "image/svg+xml"
        ? "SVG images are not accepted by Hostinger. Use JPEG, PNG, GIF or WebP."
        : `Unsupported image type "${file.mimeType}". Use JPEG, PNG, GIF or WebP.`,
    );
  }
}

export async function uploadEcommerceProductImage(
  productId: string,
  input: UploadImageInput,
  actor: EcommerceActor,
): Promise<void> {
  const via = input.file ? "file" : "url";
  try {
    if (input.file) {
      assertUploadable(input.file);
      const signed = await createImageUploadUrl(productId);
      await uploadImageToSignedUrl(signed, input.file.blob, input.file.filename);
      await attachProductImage(productId, {
        object_name: signed.object_name,
        ...(input.isThumbnail !== undefined ? { is_thumbnail: input.isThumbnail } : {}),
      });
    } else if (input.imageUrl) {
      await attachProductImage(productId, {
        image_url: input.imageUrl,
        ...(input.isThumbnail !== undefined ? { is_thumbnail: input.isThumbnail } : {}),
      });
    } else {
      const err = new Error("Provide either a file or an image URL") as Error & { status?: number };
      err.status = 422;
      throw err;
    }
  } catch (e) {
    logMutation({
      action: "product.image.add",
      actorId: actor.id,
      actorRole: actor.role,
      productId,
      fields: { via, isThumbnail: input.isThumbnail },
      outcome: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  logMutation({
    action: "product.image.add",
    actorId: actor.id,
    actorRole: actor.role,
    productId,
    fields: { via, isThumbnail: input.isThumbnail },
    outcome: "ok",
  });
}

export interface VariantCommercialInput {
  variantId: string;
  /** Batch-supported. Options and SKU are NOT — see the field list in types.ts. */
  title?: string;
  amountMinor?: number;
  /** Omit to leave the discount alone; null to CLEAR it. */
  saleAmountMinor?: number | null;
  currency?: string;
}

/**
 * Price and discount on a variant.
 *
 * SKU is deliberately absent. The batch endpoint SILENTLY IGNORES `sku` — sending
 * it alone returns 400, and sending it alongside prices returns 200 with the SKU
 * unchanged (verified 2026-08-24). The docs agree: batch updates "title,
 * inventory, stock tracking and prices". SKU can only be set when a variant is
 * CREATED, so accepting it here would report success while changing nothing.
 *
 * Two things make the rest less trivial than it looks:
 *
 *  1. The batch endpoint REPLACES a variant's prices in full. Sending only the
 *     currency being edited would silently delete a multi-currency variant's
 *     other prices — a latent defect in the original Phase 5 price path. So the
 *     current prices are read first and the target currency is replaced within
 *     them, leaving every other currency intact.
 *  2. `sale_amount: null` is rejected by the API ("must be an integer"), so a
 *     discount is cleared by OMITTING the key from the replacement price object.
 */
export async function updateEcommerceVariantCommercial(
  productId: string,
  input: VariantCommercialInput,
  actor: EcommerceActor,
): Promise<void> {
  const fields: {
    title?: string;
    prices?: { amount: number; currency: string; sale_amount?: number }[];
  } = {};

  if (input.title !== undefined) fields.title = input.title;

  const touchingPrice = input.amountMinor !== undefined || input.saleAmountMinor !== undefined;
  if (touchingPrice) {
    const variants = await listVariants(productId);
    const current = variants.find((v) => v.id === input.variantId);
    if (!current) {
      const err = new Error("Variant not found on this product") as Error & { status?: number };
      err.status = 404;
      throw err;
    }

    const targetCurrency = (
      input.currency ??
      current.prices?.[0]?.currency_code ??
      "inr"
    ).toLowerCase();

    const rebuilt = (current.prices ?? []).map((p) => {
      const code = (p.currency_code ?? "").toLowerCase();
      if (code !== targetCurrency) {
        // Untouched currency — carried over verbatim so the full-replace does
        // not drop it.
        return {
          amount: p.amount ?? 0,
          currency: code,
          ...(typeof p.sale_amount === "number" ? { sale_amount: p.sale_amount } : {}),
        };
      }
      const amount = input.amountMinor ?? p.amount ?? 0;
      // undefined = leave as-is; null = clear (by omitting the key entirely).
      const sale =
        input.saleAmountMinor === undefined
          ? typeof p.sale_amount === "number"
            ? p.sale_amount
            : undefined
          : (input.saleAmountMinor ?? undefined);
      return { amount, currency: code, ...(sale !== undefined ? { sale_amount: sale } : {}) };
    });

    // A variant with no price row yet still needs one to be priced.
    if (!rebuilt.some((p) => p.currency === targetCurrency)) {
      rebuilt.push({
        amount: input.amountMinor ?? 0,
        currency: targetCurrency,
        ...(input.saleAmountMinor ? { sale_amount: input.saleAmountMinor } : {}),
      });
    }
    fields.prices = rebuilt;
  }

  try {
    await updateVariantCommercial(productId, input.variantId, fields);
  } catch (e) {
    logMutation({
      action: "variant.commercial.update",
      actorId: actor.id,
      actorRole: actor.role,
      productId,
      fields: { ...input },
      outcome: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  logMutation({
    action: "variant.commercial.update",
    actorId: actor.id,
    actorRole: actor.role,
    productId,
    fields: { ...input, pricesSent: fields.prices?.length },
    outcome: "ok",
  });
}

/* ---------------------------------------------------------------------------
 * Options, selections and variants (Phase 8B)
 * ------------------------------------------------------------------------- */

/**
 * Derives the option/selection structure from the variants themselves, because
 * Hostinger has no option resource to read. Order follows first appearance,
 * which matches the order Hostinger reports option pairs in.
 */
export function deriveOptions(variants: EcommerceVariant[]): EcommerceOption[] {
  const byName = new Map<string, string[]>();
  for (const v of variants) {
    for (const o of v.options ?? []) {
      const list = byName.get(o.name) ?? [];
      if (!list.includes(o.value)) list.push(o.value);
      byName.set(o.name, list);
    }
  }
  return [...byName.entries()].map(([name, selections]) => ({
    name,
    selections,
    hasPlaceholder: selections.includes(HOSTINGER_PLACEHOLDER_SELECTION),
  }));
}

export interface CreateVariantInput {
  options: { name: string; value: string }[];
  sku?: string;
  amountMinor?: number;
  saleAmountMinor?: number;
  currency?: string;
  quantity?: number;
  manageInventory?: boolean;
}

/**
 * Create one variant. Everything commercial is accepted in this single call —
 * including `sale_amount`, verified — so there is no follow-up update.
 *
 * This is also the ONLY place a SKU can be set. If the caller supplies one it is
 * sent here or not at all.
 */
export async function createEcommerceVariant(
  productId: string,
  input: CreateVariantInput,
  actor: EcommerceActor,
): Promise<EcommerceVariant> {
  if (!input.options?.length) {
    // The API answers 422 "The options field is required." Failing here gives a
    // message that explains WHY rather than echoing the vendor.
    const err = new Error(
      "A variant needs at least one option (for example Size: M). Hostinger cannot create a variant without one.",
    ) as Error & { status?: number };
    err.status = 422;
    throw err;
  }

  const currency = (input.currency ?? "inr").toLowerCase();
  const body: HostingerCreateVariantRequest = {
    options: input.options,
    ...(input.sku ? { sku: input.sku } : {}),
    ...(input.amountMinor !== undefined
      ? {
          prices: [
            {
              amount: input.amountMinor,
              currency,
              // Omitted rather than nulled — the API rejects sale_amount: null.
              ...(input.saleAmountMinor !== undefined
                ? { sale_amount: input.saleAmountMinor }
                : {}),
            },
          ],
        }
      : {}),
    ...(input.quantity !== undefined ? { inventory_quantity: input.quantity } : {}),
    ...(input.manageInventory !== undefined
      ? { manage_inventory: input.manageInventory }
      : {}),
    // `title` is deliberately omitted so Hostinger's own default applies
    // ("M", "M / Red"), which keeps CRM-created variants consistent with
    // dashboard-created ones.
  };

  let created: HostingerVariant;
  try {
    created = await createVariant(productId, body);
  } catch (e) {
    logMutation({
      action: "variant.create",
      actorId: actor.id,
      actorRole: actor.role,
      productId,
      fields: { options: input.options, sku: input.sku },
      outcome: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  logMutation({
    action: "variant.create",
    actorId: actor.id,
    actorRole: actor.role,
    productId,
    fields: { variantId: created?.id, options: input.options, sku: input.sku },
    outcome: "ok",
  });
  return toVariant(created);
}

/** Raised when deleting a variant would leave the product with none. */
export class LastVariantError extends Error {
  readonly status = 409;
  constructor() {
    super(
      "This is the product's only variant. Deleting it would leave the product with no price and no stock while still published. Delete or archive the product instead.",
    );
    this.name = "LastVariantError";
  }
}

/**
 * Delete a variant, refusing to remove the last one.
 *
 * Hostinger permits this: deleting down to zero variants returns 200 and leaves a
 * PUBLISHED product with no variants, no price and no stock (verified). Nothing
 * in the API flags it, and the storefront listing is broken from that moment.
 * The count is re-read immediately before deleting rather than trusted from the
 * page, so a concurrently-deleted sibling cannot slip past the guard.
 */
export async function deleteEcommerceVariant(
  productId: string,
  variantId: string,
  actor: EcommerceActor,
): Promise<{ remaining: number }> {
  const before = await listVariants(productId);
  if (!before.some((v) => v.id === variantId)) {
    const err = new Error("Variant not found on this product") as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  if (before.length <= 1) {
    logMutation({
      action: "variant.delete",
      actorId: actor.id,
      actorRole: actor.role,
      productId,
      fields: { variantId, blockedBy: "last-variant" },
      outcome: "failed",
    });
    throw new LastVariantError();
  }

  try {
    await deleteVariant(productId, variantId);
  } catch (e) {
    logMutation({
      action: "variant.delete",
      actorId: actor.id,
      actorRole: actor.role,
      productId,
      fields: { variantId },
      outcome: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  // Read back rather than assuming the count decremented.
  const after = await listVariants(productId);
  logMutation({
    action: "variant.delete",
    actorId: actor.id,
    actorRole: actor.role,
    productId,
    fields: { variantId, remaining: after.length },
    outcome: "ok",
  });
  return { remaining: after.length };
}
