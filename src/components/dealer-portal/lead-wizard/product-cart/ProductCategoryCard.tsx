"use client";

import { ChevronDown, Pencil, Plus, X } from "lucide-react";

import { SectionCard } from "@/components/dealer-portal/lead-wizard/shared";
import type { ProductScope } from "./useProductScope";
import type { ScopeProduct } from "./types";

/** Dropdown label for a product type — mirrors Step 1, with the avail count. */
export function productOptionLabel(p: ScopeProduct): string {
  const base =
    `${p.name}${p.voltage_v ? ` — ${p.voltage_v}V` : ""}` +
    `${p.capacity_ah ? ` / ${p.capacity_ah}Ah` : ""} | SKU: ${p.sku}`;
  const avail =
    typeof p.available_quantity === "number" ? ` · ${p.available_quantity} avail.` : "";
  const oos = p.available_quantity === 0 ? " (Out of Stock)" : "";
  return base + avail + oos;
}

export function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest px-1">
        {label}
      </label>
      <div className="mt-1.5 h-11 px-4 rounded-xl bg-gray-50 border-2 border-[#F1F2F4] flex items-center text-sm font-bold text-gray-800">
        {value}
      </div>
    </div>
  );
}

export function EditableSelectField({
  label,
  value,
  options,
  onChange,
  saving,
  disabled,
  emptyText,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
  saving?: boolean;
  disabled?: boolean;
  emptyText?: string;
}) {
  const isDisabled = disabled || saving;
  return (
    <div>
      <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest px-1 flex items-center gap-1.5">
        <Pencil className="w-3 h-3" /> {label}
      </label>
      <div className="mt-1.5 relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={isDisabled}
          className={`w-full h-11 px-4 pr-10 bg-white border-2 rounded-xl text-sm font-bold outline-none appearance-none transition-colors ${
            isDisabled
              ? "border-[#F1F2F4] bg-gray-50 text-gray-400 cursor-not-allowed"
              : "border-[#EBEBEB] text-gray-900 focus:border-[#1D4ED8] focus:ring-4 focus:ring-blue-50/50"
          }`}
        >
          {!options.length && <option value="">{emptyText || "No options available"}</option>}
          {options.length > 0 && !value && <option value="">Select…</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        {saving && (
          <span className="absolute right-9 top-1/2 -translate-y-1/2 text-[10px] font-bold text-[#0047AB]">
            Saving…
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Section A — Category & Product Type (editable; mirrors Step 1).
 *
 * Mounted by whichever step owns the product for this lead: Step 4 for cash,
 * Step 5 for finance.
 */
export function ProductCategoryCard({
  scope,
  category,
  categoryName,
  productId,
  productTypeName,
  productSku,
  readOnly,
  hint,
}: {
  scope: ProductScope;
  category: string | null;
  categoryName?: string | null;
  productId: string | null;
  productTypeName?: string | null;
  productSku?: string | null;
  readOnly: boolean;
  hint?: string;
}) {
  const {
    categories,
    productsList,
    extraProductIds,
    setExtraProductIds,
    savingCategory,
    handleCategoryChange,
    handleProductChange,
  } = scope;

  return (
    <SectionCard title="Category">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {readOnly ? (
          <ReadOnlyField label="Product Category" value={categoryName || category || "—"} />
        ) : (
          <EditableSelectField
            label="Product Category"
            value={(() => {
              // Map slug-stored legacy values back to the canonical UUID so
              // the dropdown's value matches one of the options.
              const cat =
                categories.find((c) => c.id === category) ??
                categories.find((c) => c.slug === category);
              return cat?.id ?? category ?? "";
            })()}
            options={categories.map((c) => ({
              value: c.id,
              label:
                typeof c.available_count === "number"
                  ? `${c.name} (${c.available_count} in stock)`
                  : c.name,
            }))}
            onChange={handleCategoryChange}
            saving={savingCategory}
            disabled={!categories.length}
          />
        )}
        {readOnly ? (
          <ReadOnlyField
            label="Product Type"
            value={productTypeName || (productSku ? `SKU ${productSku}` : "—")}
          />
        ) : (
          <EditableSelectField
            label="Product Type"
            value={productId ?? ""}
            options={productsList.map((p) => ({ value: p.id, label: productOptionLabel(p) }))}
            onChange={handleProductChange}
            saving={savingCategory}
            disabled={!productsList.length}
            emptyText={!category ? "Pick a category first" : "No products in this category"}
          />
        )}
      </div>

      {!readOnly && (
        <div className="mt-4 space-y-3">
          {extraProductIds.map((pid, idx) => (
            <div key={idx} className="flex items-end gap-2">
              <div className="flex-1">
                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest px-1">
                  Additional Product {idx + 1}
                </label>
                <div className="mt-1.5 relative">
                  <select
                    value={pid}
                    onChange={(e) =>
                      setExtraProductIds((prev) =>
                        prev.map((v, i) => (i === idx ? e.target.value : v)),
                      )
                    }
                    disabled={!productsList.length}
                    className="w-full h-11 px-4 pr-10 bg-white border-2 border-[#EBEBEB] rounded-xl text-sm font-bold outline-none appearance-none text-gray-900 focus:border-[#1D4ED8] focus:ring-4 focus:ring-blue-50/50 disabled:bg-gray-50 disabled:text-gray-400"
                  >
                    <option value="">Select a product type…</option>
                    {productsList.map((p) => (
                      <option key={p.id} value={p.id}>
                        {productOptionLabel(p)}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                </div>
              </div>
              <button
                type="button"
                onClick={() => setExtraProductIds((prev) => prev.filter((_, i) => i !== idx))}
                className="h-11 px-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                aria-label={`Remove additional product ${idx + 1}`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setExtraProductIds((prev) => [...prev, ""])}
            disabled={!productsList.length}
            className="flex items-center gap-2 text-sm font-bold text-[#0047AB] hover:text-[#003580] disabled:opacity-40 disabled:cursor-not-allowed px-1"
          >
            <Plus className="w-4 h-4" /> Add Another Product
          </button>
        </div>
      )}

      <p className="text-[11px] text-gray-400 mt-3">
        {hint ??
          (readOnly
            ? "Category and product type were set in Step 1. Inventory below is filtered to match."
            : "Pick one or more product types — the Battery, Charger and Paraphernalia lists below show only the available stock for those products. Switching category clears the chosen battery, charger, and paraphernalia.")}
      </p>
    </SectionCard>
  );
}
