"use client";

/**
 * E-323 — list prices (tracker IDs 4 and 47), on the OEM pricing screen.
 *
 * The list price is what the quotation prints as "List price"; the dealer's
 * negotiated price below it shows as a Discount. It is optional — a product
 * with none prints its OEM price as the list price — and can never be below
 * the OEM price. Dated like the OEM price: a start date in the future is a
 * scheduled change, and a line is replaced by adding the next one.
 */

import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatINRExact } from "@/lib/format";

interface Row {
    asset_type: string;
    product_id: string;
    model_id: string;
    product_name: string;
    detail: string | null;
    oem_price: number | null;
    list_price: number | null;
    list_price_id: string | null;
    effective_from: string | null;
    valid_until: string | null;
    next_list_price: number | null;
    next_list_price_id: string | null;
    next_effective_from: string | null;
}

interface Revision {
    price_id: string;
    list_price: number;
    effective_from: string;
    effective_to: string | null;
    valid_until: string | null;
    note: string | null;
    created_by_name: string | null;
    created_at: string;
    status: "in_force" | "scheduled" | "superseded" | "expired";
}

const STATUS: Record<Revision["status"], { label: string; cls: string }> = {
    in_force: { label: "In force", cls: "bg-emerald-50 text-emerald-700" },
    scheduled: { label: "Scheduled", cls: "bg-sky-50 text-sky-700" },
    superseded: { label: "Replaced", cls: "bg-gray-100 text-gray-600" },
    expired: { label: "Expired", cls: "bg-amber-50 text-amber-700" },
};

/** Every line for one product: past prices, the one in force, everything scheduled. */
function ListPriceHistory({ row, onRemove, removing }: { row: Row; onRemove: (priceId: string) => void; removing: boolean }) {
    const { data, isLoading, isError } = useQuery<{ revisions: Revision[] }>({
        queryKey: ["list-prices", "history", row.asset_type, row.product_id],
        queryFn: async () => {
            const r = await fetch(
                `/api/dashboard/ceo/list-price-catalogue?asset_type=${encodeURIComponent(row.asset_type)}&product_id=${encodeURIComponent(row.product_id)}`,
                { cache: "no-store" },
            );
            const j = await r.json();
            if (!j.success) throw new Error(j?.error?.message ?? "Failed to load");
            return j.data;
        },
    });
    if (isLoading) return <p className="text-xs text-gray-500">Loading…</p>;
    if (isError) return <p className="text-xs text-rose-700">Could not load the history.</p>;
    const revisions = data?.revisions ?? [];
    if (revisions.length === 0) return <p className="text-xs text-gray-500">No list price has been set for this product yet.</p>;
    return (
        <table className="min-w-full text-xs">
            <thead className="text-left uppercase tracking-wide text-gray-400">
                <tr>
                    <th className="py-1 pr-3 font-semibold">Status</th>
                    <th className="py-1 pr-3 font-semibold text-right">List price</th>
                    <th className="py-1 pr-3 font-semibold">From</th>
                    <th className="py-1 pr-3 font-semibold">Until</th>
                    <th className="py-1 pr-3 font-semibold">Set by</th>
                    <th className="py-1 pr-3 font-semibold">Note</th>
                    <th className="py-1" />
                </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-gray-700">
                {revisions.map((v) => (
                    <tr key={v.price_id}>
                        <td className="py-1.5 pr-3">
                            <span className={`rounded px-1.5 py-0.5 font-semibold ${STATUS[v.status].cls}`}>{STATUS[v.status].label}</span>
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{formatINRExact(v.list_price)}</td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">{day(v.effective_from)}</td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">
                            {v.effective_to ? day(v.effective_to) : v.valid_until ? day(v.valid_until) : "Open-ended"}
                        </td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">
                            {v.created_by_name ?? "—"} · {day(v.created_at)}
                        </td>
                        <td className="py-1.5 pr-3">{v.note ?? "—"}</td>
                        <td className="py-1.5 text-right">
                            {v.status === "scheduled" && (
                                <button type="button" className="text-rose-700 underline" disabled={removing} onClick={() => onRemove(v.price_id)}>
                                    Remove
                                </button>
                            )}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

const day = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const keyOf = (r: Row) => `${r.asset_type}:${r.product_id}`;
const inputCls = "rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-800";

export function ListPricePanel() {
    const qc = useQueryClient();
    const [search, setSearch] = useState("");
    const [missingOnly, setMissingOnly] = useState(false);
    const [editing, setEditing] = useState<string | null>(null);
    const [historyFor, setHistoryFor] = useState<string | null>(null);
    const [draft, setDraft] = useState({ price: "", from: "", until: "", note: "" });
    const [error, setError] = useState<string | null>(null);

    const { data, isLoading, isError } = useQuery<{ products: Row[]; without_list_price: number }>({
        queryKey: ["list-prices"],
        queryFn: async () => {
            const r = await fetch("/api/dashboard/ceo/list-price-catalogue", { cache: "no-store" });
            const j = await r.json();
            if (!j.success) throw new Error(j?.error?.message ?? "Failed to load");
            return j.data;
        },
    });

    const call = async (method: "POST" | "DELETE", body: unknown) => {
        const r = await fetch("/api/dashboard/ceo/list-price-catalogue", {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!j.success) throw new Error(j?.error?.message ?? "Could not save");
        return j.data;
    };
    const onDone = () => {
        setEditing(null);
        setError(null);
        qc.invalidateQueries({ queryKey: ["list-prices"] });
    };
    const save = useMutation({
        mutationFn: (row: Row) =>
            call("POST", {
                asset_type: row.asset_type,
                product_id: row.product_id,
                list_price: Number(draft.price),
                effective_from: draft.from || null,
                valid_until: draft.until || null,
                note: draft.note.trim() || null,
            }),
        onSuccess: onDone,
        onError: (e: Error) => setError(e.message),
    });
    const remove = useMutation({
        mutationFn: (priceId: string) => call("DELETE", { price_id: priceId }),
        onSuccess: onDone,
        onError: (e: Error) => setError(e.message),
    });

    const rows = useMemo(() => {
        const q = search.trim().toLowerCase();
        return (data?.products ?? []).filter((p) => {
            if (missingOnly && p.list_price != null) return false;
            return !q || `${p.product_name} ${p.model_id} ${p.asset_type}`.toLowerCase().includes(q);
        });
    }, [data, search, missingOnly]);

    return (
        <section className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
            <div>
                <h2 className="text-lg font-semibold text-gray-900">List prices</h2>
                <p className="mt-1 text-sm text-gray-500">
                    The price printed on a quotation as &ldquo;List price&rdquo;. A negotiated price below it prints as a
                    Discount. Optional: a product with no list price prints its OEM price as the list price. A list price
                    can never be below the OEM price, and the OEM price still decides whether a quote needs the CEO.
                </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
                <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search product or model…"
                    className={`${inputCls} min-w-[220px] flex-1`}
                />
                <label className="flex items-center gap-1.5 text-sm text-gray-600">
                    <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
                    No list price only{data ? ` (${data.without_list_price})` : ""}
                </label>
            </div>

            {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
            {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
            {isError && <p className="text-sm text-rose-700">Could not load list prices.</p>}

            {!isLoading && !isError && (
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="py-2 px-2 font-semibold">Product</th>
                                <th className="py-2 px-2 font-semibold">Category</th>
                                <th className="py-2 px-2 font-semibold text-right">OEM price</th>
                                <th className="py-2 px-2 font-semibold text-right">List price</th>
                                <th className="py-2 px-2 font-semibold">In force</th>
                                <th className="py-2 px-2 font-semibold">Next scheduled</th>
                                <th className="py-2 px-2" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {rows.map((row) => {
                                const k = keyOf(row);
                                const open = editing === k;
                                const price = Number(draft.price);
                                const belowOem = open && row.oem_price != null && draft.price !== "" && price < row.oem_price;
                                return (
                                    <React.Fragment key={k}>
                                        <tr>
                                            <td className="py-2 px-2">
                                                <div className="font-medium text-gray-900">{row.product_name}</div>
                                                <div className="text-xs text-gray-500">{row.model_id}</div>
                                            </td>
                                            <td className="py-2 px-2 capitalize text-gray-600">{row.asset_type}</td>
                                            <td className="py-2 px-2 text-right tabular-nums text-gray-600">
                                                {row.oem_price != null ? formatINRExact(row.oem_price) : "—"}
                                            </td>
                                            <td className="py-2 px-2 text-right tabular-nums">
                                                {row.list_price != null ? (
                                                    <span className="font-semibold text-gray-900">{formatINRExact(row.list_price)}</span>
                                                ) : (
                                                    <span className="text-xs text-gray-400">Not set — OEM price prints</span>
                                                )}
                                            </td>
                                            <td className="py-2 px-2 whitespace-nowrap text-gray-600">
                                                {row.list_price != null
                                                    ? `${day(row.effective_from)}${row.valid_until ? ` – ${day(row.valid_until)}` : ""}`
                                                    : "—"}
                                            </td>
                                            <td className="py-2 px-2 whitespace-nowrap text-gray-600">
                                                {row.next_list_price != null ? (
                                                    <>
                                                        {formatINRExact(row.next_list_price)} from {day(row.next_effective_from)}{" "}
                                                        <button
                                                            type="button"
                                                            className="text-xs text-rose-700 underline"
                                                            disabled={remove.isPending}
                                                            onClick={() => row.next_list_price_id && remove.mutate(row.next_list_price_id)}
                                                        >
                                                            Remove
                                                        </button>
                                                    </>
                                                ) : (
                                                    "—"
                                                )}
                                            </td>
                                            <td className="py-2 px-2 text-right whitespace-nowrap">
                                                <button
                                                    type="button"
                                                    className="text-sm font-semibold text-blue-700 underline"
                                                    onClick={() => {
                                                        setError(null);
                                                        setEditing(open ? null : k);
                                                        setDraft({ price: row.list_price != null ? String(row.list_price) : "", from: "", until: "", note: "" });
                                                    }}
                                                >
                                                    {open ? "Cancel" : row.list_price != null ? "Revise" : "Set list price"}
                                                </button>
                                                <span className="mx-1.5 text-gray-300">|</span>
                                                <button
                                                    type="button"
                                                    className="text-sm text-blue-700 underline"
                                                    onClick={() => setHistoryFor(historyFor === k ? null : k)}
                                                >
                                                    {historyFor === k ? "Hide history" : "History"}
                                                </button>
                                            </td>
                                        </tr>
                                        {historyFor === k && (
                                            <tr className="bg-gray-50">
                                                <td colSpan={7} className="py-3 px-2">
                                                    <ListPriceHistory row={row} onRemove={(id) => remove.mutate(id)} removing={remove.isPending} />
                                                </td>
                                            </tr>
                                        )}
                                        {open && (
                                            <tr className="bg-gray-50">
                                                <td colSpan={7} className="py-3 px-2">
                                                    <div className="flex flex-wrap items-end gap-3">
                                                        <label className="text-xs text-gray-500">
                                                            List price (₹)
                                                            <input
                                                                type="number"
                                                                min={0}
                                                                step="0.01"
                                                                value={draft.price}
                                                                onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                                                                className={`${inputCls} mt-1 block w-36 tabular-nums`}
                                                            />
                                                        </label>
                                                        <label className="text-xs text-gray-500">
                                                            Starts (blank = today)
                                                            <input
                                                                type="date"
                                                                value={draft.from}
                                                                onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                                                                className={`${inputCls} mt-1 block`}
                                                            />
                                                        </label>
                                                        <label className="text-xs text-gray-500">
                                                            Valid until (optional)
                                                            <input
                                                                type="date"
                                                                value={draft.until}
                                                                onChange={(e) => setDraft({ ...draft, until: e.target.value })}
                                                                className={`${inputCls} mt-1 block`}
                                                            />
                                                        </label>
                                                        <label className="min-w-[200px] flex-1 text-xs text-gray-500">
                                                            Note (optional)
                                                            <input
                                                                value={draft.note}
                                                                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                                                                className={`${inputCls} mt-1 block w-full`}
                                                            />
                                                        </label>
                                                        <button
                                                            type="button"
                                                            disabled={save.isPending || !(price > 0) || belowOem}
                                                            onClick={() => save.mutate(row)}
                                                            className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
                                                        >
                                                            {save.isPending ? "Saving…" : "Save"}
                                                        </button>
                                                    </div>
                                                    {belowOem && (
                                                        <p className="mt-2 text-xs text-rose-700">
                                                            Below the OEM price {formatINRExact(row.oem_price!)} — a list price can never be below it.
                                                        </p>
                                                    )}
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                            {rows.length === 0 && (
                                <tr>
                                    <td colSpan={7} className="py-6 text-center text-sm text-gray-500">
                                        No product matches.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
