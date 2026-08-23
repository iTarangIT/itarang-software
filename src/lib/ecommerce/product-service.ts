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
  getProductById,
  listProducts,
  listVariants,
  updateProduct,
  updateVariantInventory,
  updateVariantPrice,
} from "@/lib/hostinger/products";
import type {
  HostingerCreateResponse,
  HostingerPrice,
  HostingerProductRow,
  HostingerProductStatus,
  HostingerVariant,
} from "@/lib/hostinger/types";
import type {
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
  return {
    ...summarise(row),
    media: (row.media ?? []).map((m) => ({ url: m.url })),
    variants: (row.variants ?? []).map(toVariant),
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

  return result;
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

export async function updateEcommerceProductPrice(
  productId: string,
  variantId: string,
  amountMinor: number,
  currency: string,
  actor: EcommerceActor,
): Promise<void> {
  try {
    await updateVariantPrice(productId, variantId, amountMinor, currency);
  } catch (e) {
    logMutation({
      action: "variant.price.update",
      actorId: actor.id,
      actorRole: actor.role,
      productId,
      fields: { variantId, amountMinor, currency },
      outcome: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
  logMutation({
    action: "variant.price.update",
    actorId: actor.id,
    actorRole: actor.role,
    productId,
    fields: { variantId, amountMinor, currency },
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
