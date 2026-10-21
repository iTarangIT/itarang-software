/**
 * One item → product mapping for every invoice line, whatever wrote it (ID 147).
 *
 * The mapping lives in vyapar_item_map (Invoice Ledger › Item mapping), keyed by
 * itemKey(item_name). mapVyaparItem() back-fills lines that already exist; this
 * is the other half: every writer of invoice_line_items — the Vyapar register
 * import, Drive invoices, the Zoho backfill — stamps a line with the mapped
 * asset_type / product_id AS IT INSERTS IT, so a line read after its item was
 * mapped no longer shows as "not linked" until someone saves the mapping again.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { itemFamilyKey, itemKey } from "@/lib/sales/invoiceLines";

export type ItemProduct = { asset_type: string | null; product_id: string | null };

type Runner = Pick<typeof db, "execute">;

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

/** SQL twin of itemKey(): lower-case, whitespace runs folded to one space, trimmed. */
export function itemKeySql(col: SQL): SQL {
    return sql`lower(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`;
}

/** Every mapped item (product set), by item key — exact keys and "code:" / "name:" family keys. */
export async function mappedItems(runner: Runner = db): Promise<Map<string, ItemProduct>> {
    const rows = rowsOf<ItemProduct & { item_key: string }>(
        await runner.execute(sql`SELECT item_key, asset_type, product_id FROM vyapar_item_map WHERE product_id IS NOT NULL`),
    );
    return new Map(rows.map((r) => [r.item_key, { asset_type: r.asset_type, product_id: r.product_id }]));
}

/**
 * The mapped product for an item name, or nulls when it is not mapped: the
 * exact spelling's own mapping first, else its product family's (code, else
 * cleaned name — itemFamilyKey).
 */
export function productFor(mapped: Map<string, ItemProduct>, itemName: string | null | undefined): ItemProduct {
    if (!itemName) return { asset_type: null, product_id: null };
    const family = itemFamilyKey(itemName);
    return mapped.get(itemKey(itemName)) ?? (family ? mapped.get(family) : undefined) ?? { asset_type: null, product_id: null };
}

/** Whether an item name has a mapping, exact or by family. */
export function isMapped(mapped: Map<string, ItemProduct>, itemName: string | null | undefined): boolean {
    return productFor(mapped, itemName).product_id != null;
}

/** A line's product class once its mapping is known: an onboarding-fee item is revenue, never a battery (ID 172). */
export function classFor(m: ItemProduct, productClass: string | null, hsn?: string | null): string | null {
    if (m.asset_type === "onboarding_fee") return "other";
    // A14: a line read with no HSN cannot be classed from it, so its Item
    // mapping decides — the same fallback gross margin uses — instead of
    // leaving a mapped battery out of Batteries sold. An HSN, when present,
    // still wins (850790, an LCD box, stays "other" whatever it is mapped to).
    if (!hsn || !String(hsn).trim()) {
        if (m.asset_type === "battery" || m.asset_type === "charger") return m.asset_type;
        if (m.asset_type) return "other";
    }
    return productClass;
}
