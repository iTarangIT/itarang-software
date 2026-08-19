"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ScopeProduct } from "./types";

/**
 * Category / Product Type — the scope that narrows the cart.
 *
 * Extracted alongside the cart so Step 5 can carry it too. A finance lead now
 * picks its category on Step 5 (Step 4 only routes the customer to lenders),
 * while a cash lead still does it on Step 4. Both need the same editable
 * dropdowns, the same lead PATCH, and the same "Add Another Product" scope.
 *
 * Edits PATCH the lead row, so a change here propagates back to Step 1.
 */

export type CatOption = {
  id: string;
  name: string;
  slug: string;
  available_count?: number;
};

const extraKey = (leadId: string) => `step4-extra-products:${leadId}`;

export interface ProductScopeContext {
  leadId: string;
  /** productCategories UUID (or a legacy slug) currently on the lead. */
  category: string | null;
  /** The lead's primary product type id. */
  productId: string | null;
  /** Re-read the lead context after a PATCH lands. */
  refetchLead: () => Promise<void>;
  /** Called when a category/product change invalidates the current cart. */
  onSelectionInvalidated: () => void;
  onError?: (message: string) => void;
}

export interface ProductScope {
  categories: CatOption[];
  productsList: ScopeProduct[];
  extraProductIds: string[];
  setExtraProductIds: React.Dispatch<React.SetStateAction<string[]>>;
  /** The primary product type plus any extra rows — what narrows the cart. */
  selectedProducts: ScopeProduct[];
  savingCategory: boolean;
  handleCategoryChange: (newCategoryId: string) => Promise<void>;
  handleProductChange: (newProductId: string) => Promise<void>;
}

export function useProductScope(ctx: ProductScopeContext): ProductScope {
  const { leadId, category, productId, refetchLead, onSelectionInvalidated } = ctx;
  const onError = ctx.onError;

  const [categories, setCategories] = useState<CatOption[]>([]);
  const [productsList, setProductsList] = useState<ScopeProduct[]>([]);
  const [extraProductIds, setExtraProductIds] = useState<string[]>([]);
  const [savingCategory, setSavingCategory] = useState(false);
  const extraRestoredRef = useRef(false);

  // ── Category list (dealer-scoped, canonicalised — mirrors Step 1) ─────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/dealer/leads/categories");
        const json = await res.json();
        if (cancelled) return;
        if (json.success) setCategories(json.data || []);
      } catch {
        // non-fatal — the card falls back to read-only display.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Product types for the active category ────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!category) {
      setProductsList([]);
      return;
    }
    // Prefer the canonical UUID; fall back to slug for leads created during
    // the window when the slug was stored in product_category_id by mistake.
    const cat =
      categories.find((c) => c.id === category) ?? categories.find((c) => c.slug === category);
    if (!cat) return; // wait for categories to arrive
    (async () => {
      try {
        const res = await fetch(
          `/api/dealer/leads/products?category=${encodeURIComponent(cat.slug)}`,
        );
        const json = await res.json();
        if (cancelled) return;
        if (json.success) setProductsList(json.data || []);
      } catch {
        // non-fatal
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [category, categories]);

  // ── Restore / persist the extra product-type filter (client-side only) ─
  useEffect(() => {
    if (extraRestoredRef.current) return;
    try {
      const raw = localStorage.getItem(extraKey(leadId));
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          setExtraProductIds(arr.filter((x): x is string => typeof x === "string"));
        }
      }
    } catch {
      // ignore corrupted value
    }
    extraRestoredRef.current = true;
  }, [leadId]);

  useEffect(() => {
    if (!extraRestoredRef.current) return;
    try {
      localStorage.setItem(extraKey(leadId), JSON.stringify(extraProductIds));
    } catch {
      // ignore storage quota / private-mode errors
    }
  }, [extraProductIds, leadId]);

  const patchLead = useCallback(
    async (body: { product_category_id?: string; primary_product_id?: string | null }) => {
      const res = await fetch(`/api/dealer/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || "Failed to update lead");
    },
    [leadId],
  );

  const handleCategoryChange = useCallback(
    async (newCategoryId: string) => {
      if (!newCategoryId || newCategoryId === category) return;
      setSavingCategory(true);
      try {
        // Per BRD §3077–3080, switching category invalidates the previously
        // chosen battery / charger / paraphernalia (compatibility no longer holds).
        await patchLead({ product_category_id: newCategoryId, primary_product_id: null });
        onSelectionInvalidated();
        await refetchLead();
      } catch (e) {
        onError?.(e instanceof Error ? e.message : "Failed to update category");
      } finally {
        setSavingCategory(false);
      }
    },
    [category, patchLead, refetchLead, onSelectionInvalidated, onError],
  );

  const handleProductChange = useCallback(
    async (newProductId: string) => {
      if (!newProductId || newProductId === productId) return;
      setSavingCategory(true);
      try {
        await patchLead({ primary_product_id: newProductId });
        // Different product → the previous serials are no longer valid.
        onSelectionInvalidated();
        await refetchLead();
      } catch (e) {
        onError?.(e instanceof Error ? e.message : "Failed to update product type");
      } finally {
        setSavingCategory(false);
      }
    },
    [productId, patchLead, refetchLead, onSelectionInvalidated, onError],
  );

  const selectedProducts = useMemo(() => {
    const ids = [productId, ...extraProductIds].filter((id): id is string => !!id);
    const seen = new Set<string>();
    const out: ScopeProduct[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const p = productsList.find((x) => x.id === id);
      if (p) out.push(p);
    }
    return out;
  }, [productId, extraProductIds, productsList]);

  return {
    categories,
    productsList,
    extraProductIds,
    setExtraProductIds,
    selectedProducts,
    savingCategory,
    handleCategoryChange,
    handleProductChange,
  };
}
