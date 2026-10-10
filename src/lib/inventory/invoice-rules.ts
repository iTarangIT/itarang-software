import type { AssetType } from "./csv-templates";

/**
 * Invoice rules for an inventory upload file.
 *
 * - A file may carry several invoice_numbers (one sheet per dealer often
 *   spans several supplier invoices).
 * - Battery/charger: within one invoice_number, every row of the same
 *   model_id must carry the same base_value. The same model on a different
 *   invoice may have a different base_value, and different models on one
 *   invoice may differ too.
 * - Paraphernalia carries no per-row base_value check.
 */

export function rowInvoiceNumber(row: Record<string, unknown>): string {
  return String(row.invoice_number ?? "").trim();
}

function rowModelKey(row: Record<string, unknown>, assetType: AssetType): string {
  const key = assetType === "paraphernalia" ? row.item_type_code : row.model_id;
  return String(key ?? "").trim().toLowerCase();
}

/** Distinct, non-empty invoice numbers in the file, in first-seen order. */
export function distinctInvoiceNumbers(rows: Record<string, unknown>[]): string[] {
  return [...new Set(rows.map(rowInvoiceNumber).filter(Boolean))];
}

export type BaseValueRef = { value: number; modelId: string; invoiceNumber: string };

/**
 * First base_value seen for each (invoice_number, model_id) pair. Rows with a
 * blank invoice/model or a non-numeric base_value don't set a reference —
 * schema validation reports those separately.
 */
export function buildBaseValueRefs(
  rows: Record<string, unknown>[],
  assetType: AssetType,
): Map<string, BaseValueRef> {
  const refs = new Map<string, BaseValueRef>();
  if (assetType === "paraphernalia") return refs;
  for (const row of rows) {
    const key = baseValueKey(row, assetType);
    if (!key || refs.has(key)) continue;
    const value = Number(row.base_value);
    if (row.base_value == null || row.base_value === "" || Number.isNaN(value)) continue;
    refs.set(key, {
      value,
      modelId: String(row.model_id ?? "").trim(),
      invoiceNumber: rowInvoiceNumber(row),
    });
  }
  return refs;
}

function baseValueKey(row: Record<string, unknown>, assetType: AssetType): string | null {
  const invoice = rowInvoiceNumber(row);
  const model = rowModelKey(row, assetType);
  if (!invoice || !model) return null;
  return `${invoice}\u0000${model}`;
}

/** The reference this row disagrees with, or null when it's consistent. */
export function baseValueMismatch(
  row: Record<string, unknown>,
  assetType: AssetType,
  refs: Map<string, BaseValueRef>,
): BaseValueRef | null {
  if (assetType === "paraphernalia") return null;
  const key = baseValueKey(row, assetType);
  if (!key) return null;
  const ref = refs.get(key);
  if (!ref) return null;
  const value = Number(row.base_value);
  if (Number.isNaN(value) || value === ref.value) return null;
  return ref;
}

export function baseValueMismatchMessage(ref: BaseValueRef): string {
  return `must be the same for every ${ref.modelId} row on invoice '${ref.invoiceNumber}' (expected ${ref.value})`;
}
