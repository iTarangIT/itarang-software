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

// ── HANDOVER-A16: SQL twin of itemFamilyKey() (invoiceLines.ts) ──────────────
// Postgres regexes (ARE) spell a word boundary \y where JS writes \b; every
// other construct used here means the same in both. The parity test
// (__tests__/itemFamilySql.test.ts) replays these steps in JS against
// itemFamilyKey() on real spellings, so a change to one side that is not made
// to the other fails there. Known gaps, none seen in invoice data: a lone \r
// before "Serial No" and non-ASCII letters next to a code (Postgres counts
// them as word characters, JS does not).

/**
 * productCode(): "fg…<letter>" then digits, a whole word. The leading zeros of
 * the digits are dropped in SQL (ltrim), as the JS pattern's 0* does — leaving
 * one "0" when the digits are all zeros.
 */
export const PRODUCT_CODE_SQL_RE = String.raw`\y(fg[a-z0-9]*[a-z])([0-9]+)\y`;

/** cleanItemName(), step by step: [pattern, replacement, every match (g) or the first]. */
export const CLEAN_NAME_SQL_STEPS: ReadonlyArray<readonly [string, string, boolean]> = [
    [String.raw`serial\s*no\.?\s*:.*$`, " ", false],
    [String.raw`\(\s*fg[a-z0-9]+\s*\)`, " ", true],
    [String.raw`\yfg[a-z]*[0-9]+\y`, " ", true],
    [String.raw`\y(orange|black|white|blue|red|green|grey|gray)\s+colou?r\y`, " ", true],
    [String.raw`,?\s*[0-9]+\s*(year|yr)s?\s*warranty`, " ", true],
    [String.raw`\ylithium\y`, "li", true],
    [String.raw`[^a-z0-9]+`, " ", true],
    [String.raw`\s+`, " ", true],
];

/** A constant as a SQL string literal (standard_conforming_strings: backslashes are literal). */
const lit = (v: string): SQL => sql.raw(`'${v.replace(/'/g, "''")}'`);

/**
 * itemFamilyKey() in SQL: 'code:<code>' when the name carries a product code,
 * else 'name:<cleaned name>', else NULL — the key Item mapping groups by, so a
 * "not linked" count by this key counts product families, as that page does.
 * Inlined literals only (no bound parameters), so the expression can sit in a
 * GROUP BY.
 */
export function itemFamilyKeySql(col: SQL): SQL {
    const code = sql`regexp_match(lower(${col}), ${lit(PRODUCT_CODE_SQL_RE)})`;
    let clean: SQL = sql`split_part(lower(${col}), chr(10), 1)`;
    for (const [pattern, replacement, global] of CLEAN_NAME_SQL_STEPS) {
        clean = global
            ? sql`regexp_replace(${clean}, ${lit(pattern)}, ${lit(replacement)}, 'g')`
            : sql`regexp_replace(${clean}, ${lit(pattern)}, ${lit(replacement)})`;
    }
    return sql`(CASE WHEN ${code} IS NOT NULL
                     THEN 'code:' || (${code})[1] || COALESCE(NULLIF(ltrim((${code})[2], '0'), ''), '0')
                     ELSE 'name:' || NULLIF(btrim(${clean}), '') END)`;
}

/**
 * A line's product_class once mapped to `assetType`, in SQL over the line's
 * own hsn / product_class columns — classFor() below, the rule every writer
 * uses on insert (ID 172: an onboarding fee is revenue, never a battery; A14:
 * a line with no HSN takes its class from the mapping).
 */
export function mappedClassSql(assetType: string | null): SQL {
    return sql`CASE
                   WHEN ${assetType}::text = 'onboarding_fee' THEN 'other'
                   WHEN COALESCE(btrim(hsn), '') = '' AND ${assetType}::text IN ('battery', 'charger') THEN ${assetType}::text
                   WHEN COALESCE(btrim(hsn), '') = '' AND ${assetType}::text IS NOT NULL THEN 'other'
                   ELSE product_class END`;
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
