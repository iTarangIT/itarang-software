"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox, Loader2, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatPriceRange } from "@/lib/ecommerce/format";
import type { EcommerceProductListResult } from "@/lib/ecommerce/types";

export function EcommerceProductListView() {
    const [page, setPage] = useState(1);

    const query = useQuery<{ success: true; data: EcommerceProductListResult }>({
        queryKey: ["ecommerce-products", page],
        queryFn: async () => {
            const u = new URL("/api/ecommerce/products", window.location.origin);
            u.searchParams.set("page", String(page));
            const res = await fetch(u.toString(), { cache: "no-store" });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error?.message ?? "Failed to load products from Hostinger");
            }
            return res.json();
        },
    });

    const data = query.data?.data;
    const rows = data?.rows ?? [];
    const total = data?.total ?? 0;
    // Page size is Hostinger's, not ours — read it back rather than assuming.
    const perPage = data?.perPage ?? 50;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const start = total === 0 ? 0 : (page - 1) * perPage + 1;
    const end = Math.min(page * perPage, total);

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <span className="text-sm text-ink-muted">
                    {query.isLoading ? "Loading..." : `${total} product${total === 1 ? "" : "s"}`}
                </span>
                <div className="flex items-center gap-3">
                    {query.isFetching && <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />}
                    <Link href="/sales-head/ecommerce/products/new">
                        <Button size="sm">
                            <Plus className="h-4 w-4" />
                            New product
                        </Button>
                    </Link>
                </div>
            </div>

            {query.error ? (
                <div className="flex items-center gap-2 bg-danger-bg/50 px-4 py-6 text-sm text-danger">
                    <AlertTriangle className="h-4 w-4" />
                    {(query.error as Error).message}
                </div>
            ) : null}

            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-4 py-3 text-left font-semibold">Product</th>
                            <th className="px-4 py-3 text-left font-semibold">SKU</th>
                            <th className="px-4 py-3 text-left font-semibold">Price</th>
                            <th className="px-4 py-3 text-left font-semibold">Stock</th>
                            <th className="px-4 py-3 text-left font-semibold">Type</th>
                            <th className="px-4 py-3 text-left font-semibold">Status</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {query.isLoading && rows.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="px-4 py-12 text-center text-ink-muted">
                                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                                </td>
                            </tr>
                        ) : null}
                        {!query.isLoading && !query.error && rows.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="px-4 py-12 text-center text-ink-muted">
                                    <Inbox className="mx-auto mb-2 h-5 w-5" />
                                    No products in the Hostinger catalog.
                                </td>
                            </tr>
                        ) : null}
                        {rows.map((p) => (
                            <tr key={p.id} className="hover:bg-bg/40">
                                <td className="px-4 py-3">
                                    <Link
                                        href={`/sales-head/ecommerce/products/${p.id}`}
                                        className="font-medium text-brand-700 hover:underline"
                                    >
                                        {p.title || "Untitled"}
                                    </Link>
                                </td>
                                <td className="px-4 py-3 font-mono text-xs text-ink-muted">
                                    {p.sku ?? `${p.variantCount} variants`}
                                </td>
                                <td className="px-4 py-3">{formatPriceRange(p.priceRange)}</td>
                                <td className="px-4 py-3">
                                    {p.totalInventory === null ? (
                                        <span className="text-ink-muted">Not tracked</span>
                                    ) : (
                                        p.totalInventory
                                    )}
                                </td>
                                <td className="px-4 py-3 text-ink-muted">{p.type ?? "—"}</td>
                                <td className="px-4 py-3">
                                    <Badge variant={p.status === "published" ? "success" : "muted"}>
                                        {p.status ?? "unknown"}
                                    </Badge>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="flex items-center justify-between border-t border-border px-4 py-3">
                <span className="text-xs text-ink-muted">
                    {total === 0 ? "No results" : `Showing ${start}-${end} of ${total}`}
                </span>
                <div className="flex items-center gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={page <= 1 || query.isFetching}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-xs text-ink-muted">
                        Page {page} of {totalPages}
                    </span>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={page >= totalPages || query.isFetching}
                        onClick={() => setPage((p) => p + 1)}
                    >
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            </div>
        </div>
    );
}
