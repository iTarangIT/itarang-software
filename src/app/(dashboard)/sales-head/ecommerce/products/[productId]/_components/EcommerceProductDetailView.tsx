"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Boxes, ExternalLink, Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatPrice, formatPriceRange } from "@/lib/ecommerce/format";
import type { EcommerceProductDetail, EcommerceVariant } from "@/lib/ecommerce/types";
import { InventoryDialog } from "./InventoryDialog";

export function EcommerceProductDetailView({ productId }: { productId: string }) {
    const query = useQuery<{ success: true; data: EcommerceProductDetail }>({
        queryKey: ["ecommerce-product", productId],
        queryFn: async () => {
            const res = await fetch(`/api/ecommerce/products/${productId}`, { cache: "no-store" });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error?.message ?? "Failed to load product from Hostinger");
            }
            return res.json();
        },
    });

    const p = query.data?.data;
    const [stockFor, setStockFor] = useState<EcommerceVariant | null>(null);

    return (
        <div className="space-y-5">
            <Link
                href="/sales-head/ecommerce/products"
                className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
            >
                <ArrowLeft className="h-4 w-4" />
                Back to products
            </Link>

            {query.isLoading ? (
                <div className="rounded-xl border border-border bg-surface p-12 text-center shadow-card">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-ink-muted" />
                </div>
            ) : null}

            {query.error ? (
                <div className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger-bg/50 px-4 py-6 text-sm text-danger">
                    <AlertTriangle className="h-4 w-4" />
                    {(query.error as Error).message}
                </div>
            ) : null}

            {p ? (
                <>
                    <header className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <h1 className="text-2xl font-semibold tracking-tight text-ink">
                                {p.title || "Untitled"}
                            </h1>
                            <Badge variant={p.status === "published" ? "success" : "muted"}>
                                {p.status ?? "unknown"}
                            </Badge>
                            {p.type ? <Badge variant="outline">{p.type}</Badge> : null}
                        </div>
                        <p className="font-mono text-xs text-ink-muted">{p.id}</p>
                        <div className="flex flex-wrap gap-2 pt-1">
                            <Link href={`/sales-head/ecommerce/products/${p.id}/edit`}>
                                <Button size="sm">
                                    <Pencil className="h-4 w-4" />
                                    Edit
                                </Button>
                            </Link>
                            <a href={p.adminUrl} target="_blank" rel="noopener noreferrer">
                                <Button size="sm" variant="outline">
                                    Edit in Hostinger
                                    <ExternalLink className="h-3.5 w-3.5" />
                                </Button>
                            </a>
                        </div>
                    </header>

                    <section className="grid gap-5 md:grid-cols-3">
                        <div className="space-y-4 md:col-span-2">
                            <Panel title="Variants and stock">
                                <VariantTable variants={p.variants} onAdjust={setStockFor} />
                            </Panel>
                        </div>

                        <div className="space-y-4">
                            <Panel title="Details">
                                <dl className="divide-y divide-border text-sm">
                                    <Row label="Type" value={p.type ?? "—"} />
                                    <Row label="Variants" value={String(p.variantCount)} />
                                    <Row label="Price range" value={formatPriceRange(p.priceRange)} />
                                </dl>
                            </Panel>

                            {p.media.length ? (
                                <Panel title="Media">
                                    <div className="grid grid-cols-3 gap-2 px-4 py-3">
                                        {p.media.map((m) => (
                                            /* eslint-disable-next-line @next/next/no-img-element */
                                            <img
                                                key={m.url}
                                                src={m.url}
                                                alt=""
                                                className="aspect-square w-full rounded-md border border-border object-cover"
                                            />
                                        ))}
                                    </div>
                                </Panel>
                            ) : null}
                        </div>
                    </section>
                </>
            ) : null}

            {stockFor && p ? (
                <InventoryDialog
                    productId={p.id}
                    variant={stockFor}
                    onClose={() => setStockFor(null)}
                    onSaved={() => {
                        // Re-fetch rather than patching local state, so the page shows
                        // what Hostinger holds rather than what we asked for.
                        void query.refetch();
                    }}
                />
            ) : null}
        </div>
    );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="border-b border-border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                {title}
            </div>
            {children}
        </div>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-baseline justify-between gap-3 px-4 py-2.5">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="text-ink">{value}</dd>
        </div>
    );
}

function VariantTable({
    variants,
    onAdjust,
}: {
    variants: EcommerceProductDetail["variants"];
    onAdjust: (v: EcommerceVariant) => void;
}) {
    if (!variants.length) {
        return <p className="px-4 py-3 text-sm text-ink-muted">No variants.</p>;
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                    <tr>
                        <th className="px-4 py-2.5 text-left font-semibold">Variant</th>
                        <th className="px-4 py-2.5 text-left font-semibold">SKU</th>
                        <th className="px-4 py-2.5 text-left font-semibold">Price</th>
                        <th className="px-4 py-2.5 text-left font-semibold">Stock</th>
                        <th className="px-4 py-2.5 text-right font-semibold"></th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {variants.map((v) => (
                        <tr key={v.id}>
                            <td className="px-4 py-2.5">
                                {v.title}
                                {v.options.length ? (
                                    <span className="ml-2 text-xs text-ink-muted">
                                        {v.options.map((o) => `${o.name}: ${o.value}`).join(", ")}
                                    </span>
                                ) : null}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-xs text-ink-muted">
                                {v.sku ?? "—"}
                            </td>
                            <td className="px-4 py-2.5">
                                {formatPrice(v.price)}
                                {v.price && v.price.saleAmountMinor !== null ? (
                                    <Badge variant="info" className="ml-2">
                                        on sale
                                    </Badge>
                                ) : null}
                            </td>
                            <td className="px-4 py-2.5">
                                {!v.manageInventory ? (
                                    <span className="text-ink-muted">Not tracked</span>
                                ) : (
                                    (v.inventoryQuantity ?? "—")
                                )}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                                <Button size="sm" variant="outline" onClick={() => onAdjust(v)}>
                                    <Boxes className="h-3.5 w-3.5" />
                                    Adjust stock
                                </Button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
