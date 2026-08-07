"use client";

/**
 * E-226 + E-230 — one product's whole price timeline: what it was, what it is,
 * and what is queued next.
 *
 * This is the audit surface. `oem_reference_prices` is append-only, so each row
 * here is a price that was genuinely the reference for the window it names, and
 * a quote approved inside that window can be checked against it. That is the
 * whole reason the price book is a table of dated lines rather than a column
 * somebody overwrites every quarter.
 *
 * E-230 added the two states that make this a *schedule* rather than a log:
 * a line can be waiting to start, and a line can have run out without anything
 * replacing it. The second is the one worth spotting — the product silently
 * stopped auto-approving — so it is coloured like the problem it is.
 *
 * Hand-rolled overlay: there is no Dialog primitive in components/ui, and the
 * existing modals (DrillDownModal) are built the same way.
 */

import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, X } from "lucide-react";
import { formatINRExact } from "@/lib/format";

interface PriceLine {
    price_id: string;
    oem_price: number;
    effective_from: string;
    effective_to: string | null;
    valid_until: string | null;
    note: string | null;
    created_by_name: string | null;
    created_at: string;
}

type LineState = "superseded" | "scheduled" | "expired" | "in_force";

/**
 * `effective_to` wins over the dates: a superseded line is history whatever its
 * declared window said, because something replaced it before that window ran
 * out.
 */
function stateOf(line: PriceLine, now: number): LineState {
    if (line.effective_to) return "superseded";
    if (new Date(line.effective_from).getTime() > now) return "scheduled";
    if (line.valid_until && new Date(line.valid_until).getTime() <= now) return "expired";
    return "in_force";
}

const STATE_PILL: Record<LineState, { label: string; className: string }> = {
    in_force: { label: "in force", className: "bg-emerald-50 text-emerald-700" },
    scheduled: { label: "scheduled", className: "bg-blue-50 text-blue-700" },
    expired: { label: "expired", className: "bg-rose-50 text-rose-700" },
    superseded: { label: "replaced", className: "bg-gray-100 text-gray-500" },
};

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

/** The window a line claims, read the way the lookup reads it. */
function windowOf(line: PriceLine, state: LineState): string {
    const from = fmt(line.effective_from);
    if (state === "superseded") return `${from} → ${fmt(line.effective_to)}`;
    return `${from} → ${line.valid_until ? fmt(line.valid_until) : "open-ended"}`;
}

export function OemPriceScheduleDrawer({
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
    const qc = useQueryClient();
    const [error, setError] = React.useState<string | null>(null);

    const { data, isLoading, isError } = useQuery<PriceLine[]>({
        queryKey: ["oem-price-schedule", assetType, productId],
        queryFn: async () => {
            const r = await fetch(
                `/api/dashboard/ceo/oem-prices/${assetType}/${encodeURIComponent(
                    productId,
                )}/history`,
                { cache: "no-store" },
            );
            if (!r.ok) throw new Error("Failed to load the price schedule");
            return ((await r.json()).data?.revisions ?? []) as PriceLine[];
        },
    });

    const remove = useMutation({
        mutationFn: async (priceId: string) => {
            const r = await fetch("/api/dashboard/ceo/oem-prices", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ price_id: priceId }),
            });
            const j = await r.json().catch(() => null);
            if (!r.ok) throw new Error(j?.error?.message ?? "Could not remove that line.");
            return j.data;
        },
        onSuccess: () => {
            setError(null);
            qc.invalidateQueries({ queryKey: ["oem-price-schedule", assetType, productId] });
            qc.invalidateQueries({ queryKey: ["oem-pricing-catalogue"] });
        },
        onError: (e: Error) => setError(e.message),
    });

    // Escape closes, matching every other overlay in the app.
    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    // Read once per mount, not per render: `stateOf` compares against it, and a
    // clock re-read on every render is both impure and pointless — a line does
    // not change state while somebody is looking at the drawer.
    const [now] = React.useState(() => Date.now());

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/30 p-4"
            onClick={onClose}
        >
            <div
                data-testid="oem-price-schedule"
                className="w-full max-w-3xl max-h-[80vh] overflow-y-auto rounded-2xl bg-white shadow-xl border border-gray-100"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-3 p-5 border-b border-gray-100 sticky top-0 bg-white">
                    <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-gray-900">Price schedule</h3>
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
                    {error && (
                        <p className="text-[11px] font-medium text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 mb-3">
                            {error}
                        </p>
                    )}
                    {isLoading && (
                        <div className="flex items-center justify-center py-10">
                            <Loader2 className="w-5 h-5 animate-spin text-gray-300" />
                        </div>
                    )}
                    {isError && (
                        <p className="text-sm text-rose-600 py-6 text-center">
                            Couldn&apos;t load the price schedule.
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
                                    <th className="py-2 px-2 font-semibold">Validity</th>
                                    <th className="py-2 px-2 font-semibold">State</th>
                                    <th className="py-2 px-2 font-semibold">Set by</th>
                                    <th className="py-2 px-2 font-semibold">Note</th>
                                    <th className="py-2 px-2 font-semibold" />
                                </tr>
                            </thead>
                            <tbody>
                                {data.map((line) => {
                                    const state = stateOf(line, now);
                                    const pill = STATE_PILL[state];
                                    const busy =
                                        remove.isPending && remove.variables === line.price_id;
                                    return (
                                        <tr
                                            key={line.price_id}
                                            className="border-b border-gray-50 align-top"
                                        >
                                            <td className="py-2 px-2 text-right tabular-nums font-semibold text-gray-900">
                                                {formatINRExact(line.oem_price)}
                                            </td>
                                            <td className="py-2 px-2 text-gray-600 whitespace-nowrap">
                                                {windowOf(line, state)}
                                            </td>
                                            <td className="py-2 px-2">
                                                <span
                                                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${pill.className}`}
                                                >
                                                    {pill.label}
                                                </span>
                                            </td>
                                            <td className="py-2 px-2 text-gray-600">
                                                {line.created_by_name ?? "—"}
                                            </td>
                                            <td className="py-2 px-2 text-gray-500">
                                                {line.note || "—"}
                                            </td>
                                            <td className="py-2 px-2 text-right">
                                                {/* Only a line that has never applied to a
                                                    quote can be dropped. Anything else is
                                                    part of the audit record. */}
                                                {state === "scheduled" && (
                                                    <button
                                                        type="button"
                                                        title="Remove this scheduled price"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            remove.mutate(line.price_id)
                                                        }
                                                        className="p-1 rounded-lg text-gray-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                                                    >
                                                        {busy ? (
                                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                        ) : (
                                                            <Trash2 className="w-3.5 h-3.5" />
                                                        )}
                                                    </button>
                                                )}
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
