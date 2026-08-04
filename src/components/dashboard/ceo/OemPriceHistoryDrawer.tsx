"use client";

/**
 * E-226 — every revision of one product's OEM reference price.
 *
 * This is the audit surface. `oem_reference_prices` is append-only, so each row
 * here is a price that was genuinely live for the window it names, and a quote
 * approved inside that window can be checked against it. That is the whole
 * reason the price book is a table of revisions rather than a column someone
 * overwrites every quarter.
 *
 * Hand-rolled overlay: there is no Dialog primitive in components/ui, and the
 * existing modals (DrillDownModal) are built the same way.
 */

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { formatINRExact } from "@/lib/format";

interface Revision {
    price_id: string;
    oem_price: number;
    effective_from: string;
    effective_to: string | null;
    note: string | null;
    created_by_name: string | null;
    created_at: string;
}

function fmt(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    });
}

export function OemPriceHistoryDrawer({
    assetType,
    productId,
    productName,
    onClose,
}: {
    assetType: string;
    productId: string;
    productName: string;
    onClose: () => void;
}) {
    const { data, isLoading, isError } = useQuery<Revision[]>({
        queryKey: ["ceo-oem-price-history", assetType, productId],
        queryFn: async () => {
            const r = await fetch(
                `/api/dashboard/ceo/oem-prices/${assetType}/${encodeURIComponent(
                    productId,
                )}/history`,
                { cache: "no-store" },
            );
            if (!r.ok) throw new Error("Failed to load price history");
            return ((await r.json()).data?.revisions ?? []) as Revision[];
        },
    });

    // Escape closes, matching every other overlay in the app.
    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/30 p-4"
            onClick={onClose}
        >
            <div
                data-testid="oem-price-history"
                className="w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-2xl bg-white shadow-xl border border-gray-100"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-3 p-5 border-b border-gray-100 sticky top-0 bg-white">
                    <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-gray-900">Price history</h3>
                        <p className="text-[11px] text-gray-500 mt-0.5 truncate">
                            {productName} · {assetType}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 shrink-0"
                        aria-label="Close"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="p-5">
                    {isLoading && (
                        <div className="flex items-center justify-center py-10">
                            <Loader2 className="w-5 h-5 animate-spin text-gray-300" />
                        </div>
                    )}
                    {isError && (
                        <p className="text-sm text-rose-600 py-6 text-center">
                            Couldn&apos;t load the price history.
                        </p>
                    )}
                    {data && data.length === 0 && (
                        <p className="text-sm text-gray-400 italic py-6 text-center">
                            No reference price has been set for this product yet.
                        </p>
                    )}
                    {data && data.length > 0 && (
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
                                    <th className="py-2 px-2 font-semibold text-right">Price</th>
                                    <th className="py-2 px-2 font-semibold">Effective</th>
                                    <th className="py-2 px-2 font-semibold">Set by</th>
                                    <th className="py-2 px-2 font-semibold">Note</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.map((rev) => {
                                    const live = rev.effective_to == null;
                                    return (
                                        <tr
                                            key={rev.price_id}
                                            className="border-b border-gray-50 align-top"
                                        >
                                            <td className="py-2 px-2 text-right tabular-nums font-semibold text-gray-900">
                                                {formatINRExact(rev.oem_price)}
                                            </td>
                                            <td className="py-2 px-2 text-gray-600">
                                                {fmt(rev.effective_from)} →{" "}
                                                {live ? (
                                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                                                        live
                                                    </span>
                                                ) : (
                                                    fmt(rev.effective_to)
                                                )}
                                            </td>
                                            <td className="py-2 px-2 text-gray-600">
                                                {rev.created_by_name ?? "—"}
                                            </td>
                                            <td className="py-2 px-2 text-gray-500">
                                                {rev.note || "—"}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </div>
    );
}
