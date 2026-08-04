"use client";

/**
 * E-226 — the OEM reference price book, on /ceo/oem-prices.
 *
 * This screen is what makes the auto-approval rule updatable without a deploy.
 * Prices move every two or three months; nothing here is compiled in.
 *
 * Unpriced products lead. They are not an empty state — each one is a product
 * whose every quote is still forced to the CEO, so the fastest way to get value
 * out of the feature is to work that list down. Hence the count in the header
 * and the filter that isolates them.
 *
 * Editing is inline, matching the reject flow on the quotations panel. Saving
 * does not overwrite: it closes the live price and opens a new one, so the
 * previous number stays readable in the history drawer.
 */

import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Loader2, Search, Tag } from "lucide-react";
import { formatINRExact } from "@/lib/format";
import { Pagination, usePagination } from "@/components/shared/Pagination";
import { SortableTh, sortRows, useTableSort, type SortSpec } from "@/components/shared/TableSort";
import { OemPriceHistoryDrawer } from "./OemPriceHistoryDrawer";

export interface OemCatalogueRow {
    asset_type: "battery" | "charger" | "paraphernalia";
    product_id: string;
    model_id: string;
    product_name: string;
    detail: string | null;
    oem_price: number | null;
    price_id: string | null;
    effective_from: string | null;
    set_by_name: string | null;
    note: string | null;
}

interface CatalogueResponse {
    products: OemCatalogueRow[];
    unpriced: number;
    total: number;
}

const ASSET_LABEL: Record<OemCatalogueRow["asset_type"], string> = {
    battery: "Battery",
    charger: "Charger",
    paraphernalia: "Paraphernalia",
};

const SORT_SPECS: SortSpec<OemCatalogueRow>[] = [
    { key: "product_name", type: "text" },
    { key: "model_id", type: "text" },
    { key: "asset_type", type: "text", value: (r) => ASSET_LABEL[r.asset_type] },
    // Unpriced rows sort as empty, which tableSortCore already pushes to the
    // end — so sorting by price never buries the rows that need attention
    // among real numbers.
    { key: "oem_price", type: "number" },
    { key: "effective_from", type: "date" },
    { key: "set_by_name", type: "text" },
];

function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    });
}

export function OemPriceTable() {
    const qc = useQueryClient();
    const [assetFilter, setAssetFilter] = React.useState<"all" | OemCatalogueRow["asset_type"]>("all");
    const [unpricedOnly, setUnpricedOnly] = React.useState(false);
    const [search, setSearch] = React.useState("");
    const [editing, setEditing] = React.useState<string | null>(null);
    const [draftPrice, setDraftPrice] = React.useState("");
    const [draftNote, setDraftNote] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const [historyFor, setHistoryFor] = React.useState<OemCatalogueRow | null>(null);

    const { data, isLoading, isError } = useQuery<CatalogueResponse>({
        queryKey: ["ceo-oem-prices"],
        queryFn: async () => {
            const r = await fetch("/api/dashboard/ceo/oem-prices", { cache: "no-store" });
            if (!r.ok) throw new Error("Failed to load the price book");
            return (await r.json()).data as CatalogueResponse;
        },
    });

    const save = useMutation({
        mutationFn: async (vars: {
            row: OemCatalogueRow;
            oem_price: number;
            note: string | null;
        }) => {
            const r = await fetch("/api/dashboard/ceo/oem-prices", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    asset_type: vars.row.asset_type,
                    product_id: vars.row.product_id,
                    oem_price: vars.oem_price,
                    note: vars.note,
                }),
            });
            const j = await r.json().catch(() => null);
            if (!r.ok) throw new Error(j?.error?.message ?? "Could not save the price");
            return j.data;
        },
        onSuccess: () => {
            setEditing(null);
            setDraftPrice("");
            setDraftNote("");
            setError(null);
            qc.invalidateQueries({ queryKey: ["ceo-oem-prices"] });
            // A price change can flip later quotes to auto-approve, so the
            // pending queue on /ceo is no longer necessarily accurate.
            qc.invalidateQueries({ queryKey: ["ceo-pending-quotations"] });
        },
        onError: (e: Error) => setError(e.message),
    });

    const products = React.useMemo(() => data?.products ?? [], [data]);

    const filtered = React.useMemo(() => {
        const q = search.trim().toLowerCase();
        return products.filter((p) => {
            if (assetFilter !== "all" && p.asset_type !== assetFilter) return false;
            if (unpricedOnly && p.oem_price != null) return false;
            if (!q) return true;
            return (
                p.product_name.toLowerCase().includes(q) ||
                p.model_id.toLowerCase().includes(q)
            );
        });
    }, [products, assetFilter, unpricedOnly, search]);

    const { sort, toggle, comparator } = useTableSort<OemCatalogueRow>(SORT_SPECS);
    const sorted = React.useMemo(() => sortRows(filtered, comparator), [filtered, comparator]);
    const paged = usePagination(sorted, 15);

    function beginEdit(row: OemCatalogueRow) {
        setEditing(rowKey(row));
        setDraftPrice(row.oem_price != null ? String(row.oem_price) : "");
        setDraftNote("");
        setError(null);
    }

    if (isLoading) {
        return (
            <Shell>
                <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-5 h-5 animate-spin text-gray-300" />
                </div>
            </Shell>
        );
    }

    if (isError) {
        return (
            <Shell>
                <p className="text-sm text-rose-600 py-8 text-center">
                    Couldn&apos;t load the OEM price book.
                </p>
            </Shell>
        );
    }

    return (
        <Shell unpriced={data?.unpriced ?? 0} total={data?.total ?? 0}>
            {(data?.unpriced ?? 0) > 0 && (
                <p className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3">
                    {data?.unpriced} of {data?.total} products have no reference price. Every
                    quote containing one of them goes to the approval queue.
                </p>
            )}
            {error && (
                <p className="text-[11px] font-medium text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 mb-3">
                    {error}
                </p>
            )}

            <div className="flex items-center gap-2 mb-3 flex-wrap">
                <div className="relative">
                    <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Product or model id"
                        className="h-8 pl-8 pr-2 rounded-lg border border-gray-200 text-xs outline-none focus:border-brand-300 w-56"
                    />
                </div>
                <div className="flex items-center gap-1">
                    {(["all", "battery", "charger", "paraphernalia"] as const).map((a) => (
                        <button
                            key={a}
                            type="button"
                            onClick={() => setAssetFilter(a)}
                            className={`h-8 px-3 rounded-lg text-[11px] font-semibold transition-colors ${
                                assetFilter === a
                                    ? "bg-brand-600 text-white"
                                    : "border border-gray-200 text-gray-600 hover:bg-gray-50"
                            }`}
                        >
                            {a === "all" ? "All" : ASSET_LABEL[a]}
                        </button>
                    ))}
                </div>
                <button
                    type="button"
                    onClick={() => setUnpricedOnly((v) => !v)}
                    className={`h-8 px-3 rounded-lg text-[11px] font-semibold transition-colors ${
                        unpricedOnly
                            ? "bg-amber-500 text-white"
                            : "border border-gray-200 text-gray-600 hover:bg-gray-50"
                    }`}
                >
                    No price set
                </button>
            </div>

            {sorted.length === 0 ? (
                <p className="text-sm text-gray-400 italic py-8 text-center">
                    No products match these filters.
                </p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
                                <SortableTh label="Product" sortKey="product_name" sort={sort} onToggle={toggle} />
                                <SortableTh label="Model ID" sortKey="model_id" sort={sort} onToggle={toggle} />
                                <SortableTh label="Type" sortKey="asset_type" sort={sort} onToggle={toggle} />
                                <SortableTh label="OEM Price" sortKey="oem_price" sort={sort} onToggle={toggle} align="right" />
                                <SortableTh label="Effective From" sortKey="effective_from" sort={sort} onToggle={toggle} />
                                <SortableTh label="Set By" sortKey="set_by_name" sort={sort} onToggle={toggle} />
                                <SortableTh label="" sort={sort} onToggle={toggle} align="right" />
                            </tr>
                        </thead>
                        <tbody>
                            {paged.pageItems.map((row) => {
                                const key = rowKey(row);
                                const isEditing = editing === key;
                                const busy =
                                    save.isPending && rowKey(save.variables!.row) === key;
                                return (
                                    <tr key={key} className="border-b border-gray-50 align-top">
                                        <td className="py-2 px-2">
                                            <span className="font-medium text-gray-900">
                                                {row.product_name}
                                            </span>
                                            {row.detail && (
                                                <span className="block text-[10px] text-gray-400">
                                                    {row.detail}
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-2 px-2 text-gray-600">{row.model_id}</td>
                                        <td className="py-2 px-2 text-gray-600">
                                            {ASSET_LABEL[row.asset_type]}
                                        </td>
                                        <td className="py-2 px-2 text-right tabular-nums">
                                            {isEditing ? (
                                                <input
                                                    autoFocus
                                                    type="number"
                                                    min={0}
                                                    step="0.01"
                                                    value={draftPrice}
                                                    onChange={(e) => setDraftPrice(e.target.value)}
                                                    className="h-7 w-28 px-2 text-right rounded-lg border border-gray-200 text-xs outline-none focus:border-brand-300"
                                                />
                                            ) : row.oem_price != null ? (
                                                <span className="font-semibold text-gray-900">
                                                    {formatINRExact(row.oem_price)}
                                                </span>
                                            ) : (
                                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                                                    not set
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-2 px-2 text-gray-600">
                                            {isEditing ? (
                                                <input
                                                    value={draftNote}
                                                    onChange={(e) => setDraftNote(e.target.value)}
                                                    placeholder="Note (optional)"
                                                    className="h-7 w-44 px-2 rounded-lg border border-gray-200 text-xs outline-none focus:border-brand-300"
                                                />
                                            ) : (
                                                fmtDate(row.effective_from)
                                            )}
                                        </td>
                                        <td className="py-2 px-2 text-gray-600">
                                            {row.set_by_name ?? "—"}
                                        </td>
                                        <td className="py-2 px-2 text-right whitespace-nowrap">
                                            {isEditing ? (
                                                <>
                                                    <button
                                                        type="button"
                                                        disabled={busy || !isValidPrice(draftPrice)}
                                                        onClick={() =>
                                                            save.mutate({
                                                                row,
                                                                oem_price: Number(draftPrice),
                                                                note: draftNote.trim() || null,
                                                            })
                                                        }
                                                        className="h-7 px-3 rounded-lg text-[11px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
                                                    >
                                                        {busy ? "…" : "Save"}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setEditing(null)}
                                                        className="h-7 px-2 ml-1 rounded-lg text-[11px] font-semibold text-gray-500 hover:bg-gray-100"
                                                    >
                                                        Cancel
                                                    </button>
                                                </>
                                            ) : (
                                                <>
                                                    <button
                                                        type="button"
                                                        onClick={() => beginEdit(row)}
                                                        className="h-7 px-3 rounded-lg text-[11px] font-bold border border-gray-200 text-gray-600 hover:bg-gray-50"
                                                    >
                                                        {row.oem_price != null ? "Revise" : "Set price"}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        title="Price history"
                                                        disabled={row.oem_price == null}
                                                        onClick={() => setHistoryFor(row)}
                                                        className="h-7 px-2 ml-1 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-30 disabled:hover:bg-transparent"
                                                    >
                                                        <History className="w-3.5 h-3.5 inline" />
                                                    </button>
                                                </>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            <Pagination
                page={paged.page}
                pageCount={paged.pageCount}
                onPageChange={paged.setPage}
                total={paged.total}
                from={paged.from}
                to={paged.to}
                noun="products"
            />

            {historyFor && (
                <OemPriceHistoryDrawer
                    assetType={historyFor.asset_type}
                    productId={historyFor.product_id}
                    productName={historyFor.product_name}
                    onClose={() => setHistoryFor(null)}
                />
            )}
        </Shell>
    );
}

function rowKey(r: OemCatalogueRow): string {
    return `${r.asset_type}:${r.product_id}`;
}

/** Guards the Save button — an empty or non-numeric box must not POST NaN. */
function isValidPrice(v: string): boolean {
    if (v.trim() === "") return false;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0;
}

function Shell({
    children,
    unpriced,
    total,
}: {
    children: React.ReactNode;
    unpriced?: number;
    total?: number;
}) {
    return (
        <div
            data-testid="oem-price-table"
            className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm"
        >
            <div className="flex items-center gap-2 mb-4">
                <Tag className="w-4 h-4 text-gray-400" />
                <h3 className="text-sm font-semibold text-gray-900">OEM Reference Prices</h3>
                {total != null && total > 0 && (
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-gray-50 text-gray-600">
                        {total - (unpriced ?? 0)}/{total} priced
                    </span>
                )}
            </div>
            {children}
        </div>
    );
}
