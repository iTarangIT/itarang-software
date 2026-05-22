'use client';

// 3-level cascading product picker for the dealer new-lead form's
// "Product Details" card: Asset Type -> Product Category -> Product Type.
// Self-contained — owns its own categories/products fetching, scoped by the
// chosen asset kind. Used once for the primary product and once per
// "Add Another Product" row.

import { useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, X } from 'lucide-react';

export type AssetKind = 'battery' | 'charger' | 'paraphernalia';

export type ProductSelectorValue = {
    asset_type: '' | AssetKind;
    category_id: string;        // productCategories UUID
    category_slug: string;      // '2w' | '3w' | '4w'
    category_name: string;      // display label, e.g. "3W"
    is_vehicle_category: boolean;
    product_id: string;         // products UUID
    product_name: string;       // selected product display name
};

export const EMPTY_PRODUCT_SELECTION: ProductSelectorValue = {
    asset_type: '',
    category_id: '',
    category_slug: '',
    category_name: '',
    is_vehicle_category: false,
    product_id: '',
    product_name: '',
};

const ASSET_KINDS: { value: AssetKind; label: string }[] = [
    { value: 'battery', label: 'Battery' },
    { value: 'charger', label: 'Charger' },
    { value: 'paraphernalia', label: 'Paraphernalia' },
];

interface CategoryOption {
    id: string;
    name: string;
    slug: string;
    isVehicleCategory: boolean;
    available_count: number;
}

interface ProductSerial {
    id: string;
    serial_number: string | null;
    warehouse_location: string | null;
}

interface ProductOption {
    id: string;
    name: string;
    sku: string;
    voltage_v: number | null;
    capacity_ah: number | null;
    warranty_months: number | null;
    available_quantity: number;
    serials: ProductSerial[];
}

interface ProductSelectorProps {
    value: ProductSelectorValue;
    onChange: (next: ProductSelectorValue) => void;
    errors?: { category?: string; product?: string };
    /** When set, the selector renders inside a labelled grey box (extra rows). */
    label?: string;
    /** Primary product shows the available-serials chips; extra rows don't. */
    showSerials?: boolean;
    /** Out-of-stock "Order from OEM" action (primary product only). */
    onOrderFromOem?: () => void;
    /** When set, renders an X button to remove this row (extra rows). */
    onRemove?: () => void;
}

const SELECT_BASE =
    'w-full h-11 px-4 pr-10 bg-white border-2 rounded-xl outline-none appearance-none text-sm transition-all disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed';

function productOptionLabel(p: ProductOption, outOfStock: boolean): string {
    return (
        `${p.name} — ${p.voltage_v}V / ${p.capacity_ah}Ah | SKU: ${p.sku}` +
        (p.warranty_months ? ` | ${p.warranty_months}mo warranty` : '') +
        (typeof p.available_quantity === 'number' ? ` · ${p.available_quantity} avail.` : '') +
        (outOfStock ? ' (Out of Stock)' : '')
    );
}

export default function ProductSelector({
    value,
    onChange,
    errors,
    label,
    showSerials = false,
    onOrderFromOem,
    onRemove,
}: ProductSelectorProps) {
    // Fetched lists are tagged with the asset kind / category they belong to.
    // The lists actually rendered are *derived* from these (see below) — so
    // switching the asset type instantly shows an empty list (no stale data)
    // without a synchronous setState inside the effect.
    const [catData, setCatData] = useState<{ assetType: string; rows: CategoryOption[] }>({
        assetType: '',
        rows: [],
    });
    const [prodData, setProdData] = useState<{ key: string; rows: ProductOption[] }>({
        key: '',
        rows: [],
    });

    // Categories scoped to the chosen asset kind. AbortController discards the
    // response of a superseded fetch when the dealer flips the asset type fast.
    useEffect(() => {
        if (!value.asset_type) return;
        const ac = new AbortController();
        const at = value.asset_type;
        fetch(`/api/dealer/leads/categories?assetType=${at}`, { signal: ac.signal })
            .then(r => r.json())
            .then(d => {
                if (!ac.signal.aborted) {
                    setCatData({ assetType: at, rows: d?.success ? d.data ?? [] : [] });
                }
            })
            .catch(e => {
                if (e?.name !== 'AbortError' && !ac.signal.aborted) {
                    setCatData({ assetType: at, rows: [] });
                }
            });
        return () => ac.abort();
    }, [value.asset_type]);

    // Products scoped to asset kind + category.
    useEffect(() => {
        if (!value.asset_type || !value.category_slug) return;
        const ac = new AbortController();
        const at = value.asset_type;
        const slug = value.category_slug;
        const key = `${at}|${slug}`;
        fetch(
            `/api/dealer/leads/products?category=${encodeURIComponent(slug)}&assetType=${at}`,
            { signal: ac.signal },
        )
            .then(r => r.json())
            .then(d => {
                if (!ac.signal.aborted) {
                    setProdData({ key, rows: d?.success ? d.data ?? [] : [] });
                }
            })
            .catch(e => {
                if (e?.name !== 'AbortError' && !ac.signal.aborted) {
                    setProdData({ key, rows: [] });
                }
            });
        return () => ac.abort();
    }, [value.asset_type, value.category_slug]);

    // Derived view state — empty until the matching fetch resolves, so the
    // dropdowns never show data belonging to a different asset kind / category.
    const categoriesReady = !!value.asset_type && catData.assetType === value.asset_type;
    const categories = categoriesReady ? catData.rows : [];
    const loadingCategories = !!value.asset_type && !categoriesReady;

    const productKey =
        value.asset_type && value.category_slug
            ? `${value.asset_type}|${value.category_slug}`
            : '';
    const productsReady = !!productKey && prodData.key === productKey;
    const products = productsReady ? prodData.rows : [];
    const loadingProducts = !!productKey && !productsReady;

    const outOfStock = new Set(
        products.filter(p => p.available_quantity === 0).map(p => p.id),
    );

    // ─── Cascade change handlers — always emit a fresh object ───────────────
    const handleAssetTypeChange = (next: string) => {
        // Changing the asset kind clears everything downstream.
        onChange({
            ...EMPTY_PRODUCT_SELECTION,
            asset_type: (ASSET_KINDS.some(k => k.value === next) ? next : '') as '' | AssetKind,
        });
    };

    const handleCategoryChange = (slug: string) => {
        const cat = categories.find(c => c.slug === slug);
        // Changing the category clears the product.
        onChange({
            ...value,
            category_slug: cat?.slug ?? slug,
            category_id: cat?.id ?? '',
            category_name: cat?.name ?? '',
            is_vehicle_category: cat?.isVehicleCategory ?? false,
            product_id: '',
            product_name: '',
        });
    };

    const handleProductChange = (id: string) => {
        const prod = products.find(p => p.id === id);
        onChange({ ...value, product_id: id, product_name: prod?.name ?? '' });
    };

    const selectedProduct = products.find(p => p.id === value.product_id);
    const serials = selectedProduct?.serials ?? [];

    // ─── Field blocks ──────────────────────────────────────────────────────
    const assetTypeField = (
        <div className="space-y-2">
            <label className="text-sm font-bold text-gray-900 px-1">
                Asset Type <span className="text-red-500">*</span>
            </label>
            <div className="relative">
                <select
                    value={value.asset_type}
                    onChange={e => handleAssetTypeChange(e.target.value)}
                    className={`${SELECT_BASE} border-[#EBEBEB] focus:border-[#1D4ED8] ${!value.asset_type ? 'text-gray-400' : 'text-gray-900'}`}
                >
                    <option value="">Select asset type</option>
                    {ASSET_KINDS.map(k => (
                        <option key={k.value} value={k.value}>{k.label}</option>
                    ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            </div>
        </div>
    );

    const categoryField = (
        <div className="space-y-2">
            <label className="text-sm font-bold text-gray-900 px-1">
                Product Category <span className="text-red-500">*</span>
            </label>
            <div className="relative">
                <select
                    value={value.category_slug}
                    disabled={!value.asset_type}
                    onChange={e => handleCategoryChange(e.target.value)}
                    className={`${SELECT_BASE} ${errors?.category ? 'border-red-400' : 'border-[#EBEBEB] focus:border-[#1D4ED8]'} ${!value.category_slug ? 'text-gray-400' : 'text-gray-900'}`}
                >
                    <option value="" disabled={categories.length === 0}>
                        {!value.asset_type
                            ? 'Select an asset type first'
                            : loadingCategories
                                ? 'Loading…'
                                : categories.length === 0
                                    ? 'No inventory available for this asset type'
                                    : 'Select from Current Inventory'}
                    </option>
                    {categories.map(c => (
                        <option key={c.id} value={c.slug}>
                            {c.name}
                            {typeof c.available_count === 'number' ? ` (${c.available_count} in stock)` : ''}
                        </option>
                    ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            </div>
            {errors?.category && <p className="text-[10px] text-red-500 font-bold px-1">{errors.category}</p>}
        </div>
    );

    const productField = (
        <div className="space-y-2">
            <label className="text-sm font-bold text-gray-900 px-1">Product Type</label>
            <div className="relative">
                <select
                    value={value.product_id}
                    disabled={!value.category_slug}
                    onChange={e => handleProductChange(e.target.value)}
                    className={`${SELECT_BASE} ${errors?.product ? 'border-red-400' : 'border-[#EBEBEB] focus:border-[#1D4ED8]'} ${!value.product_id ? 'text-gray-400' : 'text-gray-900'}`}
                >
                    <option value="" disabled={products.length === 0}>
                        {!value.category_slug
                            ? 'Select a category first'
                            : loadingProducts
                                ? 'Loading…'
                                : products.length === 0
                                    ? 'No stock available in this category'
                                    : 'Select Product type'}
                    </option>
                    {products.map(p => (
                        <option key={p.id} value={p.id}>
                            {productOptionLabel(p, outOfStock.has(p.id))}
                        </option>
                    ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            </div>

            {value.product_id && outOfStock.has(value.product_id) && (
                <div className="flex items-center justify-between gap-3 px-3 py-3 bg-amber-50 border border-amber-200 rounded-lg mt-2">
                    <div className="flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                        <span className="text-xs font-medium text-amber-700">Product out of stock</span>
                    </div>
                    {onOrderFromOem && (
                        <button
                            type="button"
                            onClick={onOrderFromOem}
                            className="px-3 py-1 text-xs font-bold bg-amber-600 text-white rounded-lg hover:bg-amber-700"
                        >
                            Order from OEM
                        </button>
                    )}
                </div>
            )}

            {showSerials && selectedProduct && serials.length > 0 && (
                <div className="mt-2 rounded-xl border border-emerald-100 bg-emerald-50/60 p-3">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 mb-2">
                        Available serials ({selectedProduct.available_quantity})
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        {serials.slice(0, 6).map(s => (
                            <span
                                key={s.id}
                                title={s.warehouse_location ? `${s.serial_number || s.id} · ${s.warehouse_location}` : s.serial_number || s.id}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white border border-emerald-200 text-[11px] font-mono text-emerald-900"
                            >
                                {s.serial_number || s.id}
                                {s.warehouse_location && (
                                    <span className="text-[10px] text-emerald-600/80 font-sans">· {s.warehouse_location}</span>
                                )}
                            </span>
                        ))}
                        {serials.length > 6 && (
                            <span className="inline-flex items-center px-2 py-1 rounded-lg bg-emerald-100 border border-emerald-200 text-[11px] font-bold text-emerald-800">
                                +{serials.length - 6} more
                            </span>
                        )}
                    </div>
                </div>
            )}

            {errors?.product && <p className="text-[10px] text-red-500 font-bold px-1">{errors.product}</p>}
        </div>
    );

    // ─── Layout ────────────────────────────────────────────────────────────
    if (label) {
        return (
            <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 space-y-4">
                <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-600 px-1">{label}</span>
                    {onRemove && (
                        <button
                            type="button"
                            onClick={onRemove}
                            className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>
                {assetTypeField}
                {categoryField}
                {productField}
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {assetTypeField}
            {categoryField}
            {productField}
        </div>
    );
}
