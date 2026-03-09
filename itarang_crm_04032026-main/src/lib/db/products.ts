/**
 * Data access helpers for product_categories + products tables.
 * Replaces all usage of product_catalog.
 */
import { db } from '@/lib/db';
import { productCategories, products } from '@/lib/db/schema';
import { eq, asc } from 'drizzle-orm';

/** All active categories ordered by name */
export async function listCategories() {
    return db
        .select()
        .from(productCategories)
        .where(eq(productCategories.is_active, true))
        .orderBy(asc(productCategories.name));
}

/** Products under a category, ordered by sort_order */
export async function listProductsByCategorySlug(slug: string) {
    const [cat] = await db
        .select()
        .from(productCategories)
        .where(eq(productCategories.slug, slug))
        .limit(1);

    if (!cat) return [];

    return db
        .select()
        .from(products)
        .where(eq(products.category_id, cat.id))
        .orderBy(asc(products.sort_order));
}

/** Single product by SKU, with its category */
export async function getProductBySku(sku: string) {
    const [row] = await db
        .select({
            product: products,
            category: productCategories,
        })
        .from(products)
        .innerJoin(productCategories, eq(products.category_id, productCategories.id))
        .where(eq(products.sku, sku))
        .limit(1);

    return row ?? null;
}

/** All active products (optionally filtered by category slug) */
export async function listProducts(categorySlug?: string) {
    if (categorySlug) return listProductsByCategorySlug(categorySlug);

    return db
        .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            sku: products.sku,
            voltage_v: products.voltage_v,
            capacity_ah: products.capacity_ah,
            hsn_code: products.hsn_code,
            asset_type: products.asset_type,
            is_serialized: products.is_serialized,
            warranty_months: products.warranty_months,
            status: products.status,
            sort_order: products.sort_order,
            is_active: products.is_active,
            category_id: products.category_id,
        })
        .from(products)
        .where(eq(products.is_active, true))
        .orderBy(asc(products.sort_order));
}

/** Search products by voltage and/or capacity */
export async function searchProducts(opts: {
    voltage_v?: number;
    capacity_ah?: number;
    category_slug?: string;
}) {
    const conditions = [eq(products.is_active, true)];

    if (opts.category_slug) {
        const [cat] = await db
            .select({ id: productCategories.id })
            .from(productCategories)
            .where(eq(productCategories.slug, opts.category_slug))
            .limit(1);
        if (cat) conditions.push(eq(products.category_id, cat.id));
    }

    if (opts.voltage_v) {
        const { eq: eqFn } = await import('drizzle-orm');
        conditions.push(eqFn(products.voltage_v, opts.voltage_v));
    }
    if (opts.capacity_ah) {
        const { eq: eqFn } = await import('drizzle-orm');
        conditions.push(eqFn(products.capacity_ah, opts.capacity_ah));
    }

    const { and } = await import('drizzle-orm');
    return db
        .select()
        .from(products)
        .where(and(...conditions))
        .orderBy(asc(products.sort_order));
}
