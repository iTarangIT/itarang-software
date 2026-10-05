"use client";

/**
 * E-321 (tracker ID 4 / handover P1-14) — one product's LIST PRICE: set a new
 * line, see the schedule and history, drop a line that has not started.
 *
 * The list price is what prints on the quotation as "List price", with the
 * discount down to the quoted rate. It is optional — with none in force the OEM
 * price prints — and it never decides approval; the OEM price still does.
 * It can never be below the OEM price in any window; the server refuses that
 * with the reason, which is shown here as-is.
 *
 * Same hand-rolled overlay as OemPriceScheduleDrawer.
 */

import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, X } from "lucide-react";
import { formatINRExact } from "@/lib/format";

interface ListLine {
    price_id: string;
    list_price: number;
    effective_from: string;
    effective_to: string | null;
    valid_until: string | null;
    note: string | null;
    created_by_name: string | null;
    created_at: string;
}

type LineState = "superseded" | "scheduled" | "expired" | "in_force";

function stateOf(line: ListLine, now: number): LineState {
    if (line.effective_to) return "superseded";
    if (new Date(line.effective_from).getTime() > now) return "scheduled";
    if (line.valid_until && new Date(line.valid_until).getTime() <= now) return "expired";
    return "in_force";
}

const STATE_PILL: Record<LineState, { label: string; className: string }> = {
    in_force: { label: "in force", className: "bg-emerald-50 text-emerald-700" },
    scheduled: { label: "scheduled", className: "bg-blue-50 text-blue-700" },
    expired: { label: "expired", className: "bg-gray-100 text-gray-500" },
    superseded: { label: "replaced", className: "bg-gray-100 text-gray-500" },
};

function fmt(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function windowOf(line: ListLine, state: LineState): string {
    const from = fmt(line.effective_from);
    if (state === "superseded") return `${from} → ${fmt(line.effective_to)}`;
    return `${from} → ${line.valid_until ? fmt(line.valid_until) : "open-ended"}`;
}

function todayInput(): string {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export function ListPriceDrawer({
    assetType,
    productId,
    productName,
    oemPrice,
    onClose,
}: {
    assetType: string;
    productId: string;
    productName: string;
    /** The OEM price in force, for the hint and the client-side floor. */
    oemPrice: number | null;
    onClose: () => void;
}) {
    const qc = useQueryClient();
    const [error, setError] = React.useState<string | null>(null);
    const [price, setPrice] = React.useState("");
    const [from, setFrom] = React.useState(todayInput());
    const [until, setUntil] = React.useState("");
    const [note, setNote] = React.useState("");
    const [now] = React.useState(() => Date.now());

    const historyKey = ["list-price-schedule", assetType, productId];

    const { data, isLoading, isError } = useQuery<ListLine[]>({
        queryKey: historyKey,
        queryFn: async () => {
            const r = await fetch(
                `/api/dashboard/ceo/list-prices/${assetType}/${encodeURIComponent(productId)}/history`,
                { cache: "no-store" },
            );
            if (!r.ok) throw new Error("Failed to load the list price schedule");
            return ((await r.json()).data?.revisions ?? []) as ListLine[];
        },
    });

    const refresh = () => {
        qc.invalidateQueries({ queryKey: historyKey });
        qc.invalidateQueries({ queryKey: ["list-price-catalogue"] });
    };

    const save = useMutation({
        mutationFn: async () => {
            const r = await fetch("/api/dashboard/ceo/list-prices", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    asset_type: assetType,
                    product_id: productId,
                    list_price: Number(price),
                    effective_from: from || null,
                    valid_until: until || null,
                    note: note.trim() || null,
                }),
            });
            const j = await r.json().catch(() => null);
            if (!r.ok) throw new Error(j?.error?.message ?? "Could not save the list price");
            return j.data;
        },
        onSuccess: () => {
            setError(null);
            setPrice("");
            setUntil("");
            setNote("");
            refresh();
        },
        onError: (e: Error) => setError(e.message),
    });

    const remove = useMutation({
        mutationFn: async (priceId: string) => {
            const r = await fetch("/api/dashboard/ceo/list-prices", {
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
            refresh();
        },
        onError: (e: Error) => setError(e.message),
    });

    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const n = Number(price);
    const priceOk = price.trim() !== "" && Number.isFinite(n) && n >= 0;
    // The server checks every overlapping OEM window; this only catches the
    // obvious case against the price in force, before a round trip.
    const belowOem = priceOk && oemPrice != null && n < oemPrice;
    const datesOk = !from || !until || new Date(until) > new Date(from);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/30 p-4"
            onClick={onClose}
        >
            <div
                data-testid="list-price-drawer"
                className="w-full max-w-3xl max-h-[80vh] overflow-y-auto rounded-2xl bg-white shadow-xl border border-gray-100"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-3 p-5 border-b border-gray-100 sticky top-0 bg-white">
                    <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-gray-900">List price</h3>
                        <p className="text-[11px] text-gray-500 mt-0.5 truncate">
                            {productName} · {assetType} · printed on quotations; never below the
                            OEM price. With none set, the OEM price prints.
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

                <div className="p-5 space-y-4">
                    {error && (
                        <p className="text-[11px] font-medium text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
                            {error}
                        </p>
                    )}

                    <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-3 space-y-2">
                        <p className="text-[11px] font-semibold text-gray-700">
                            Add a list price line
                            <span className="font-normal text-gray-500">
                                {" "}
                                — starting today replaces the one in force; a later start queues
                                behind it.
                            </span>
                        </p>
                        <div className="flex flex-wrap items-end gap-3">
                            <Field label="List price (₹)">
                                <input
                                    autoFocus
                                    type="number"
                                    min={oemPrice ?? 0}
                                    step="0.01"
                                    value={price}
                                    onChange={(e) => setPrice(e.target.value)}
                                    className="h-8 w-32 px-2 text-right rounded-lg border border-gray-200 text-xs outline-none focus:border-brand-300"
                                />
                            </Field>
                            <Field label="Valid from">
                                <input
                                    type="date"
                                    value={from}
                                    onChange={(e) => setFrom(e.target.value)}
                                    className="h-8 w-36 px-2 rounded-lg border border-gray-200 text-xs outline-none focus:border-brand-300"
                                />
                            </Field>
                            <Field label="Valid until" hint="blank = open-ended">
                                <input
                                    type="date"
                                    value={until}
                                    min={from || undefined}
                                    onChange={(e) => setUntil(e.target.value)}
                                    className="h-8 w-36 px-2 rounded-lg border border-gray-200 text-xs outline-none focus:border-brand-300"
                                />
                            </Field>
                            <Field label="Note" hint="optional">
                                <input
                                    value={note}
                                    onChange={(e) => setNote(e.target.value)}
                                    placeholder="e.g. MRP revision Oct"
                                    className="h-8 w-48 px-2 rounded-lg border border-gray-200 text-xs outline-none focus:border-brand-300"
                                />
                            </Field>
                            <button
                                type="button"
                                disabled={save.isPending || !priceOk || belowOem || !datesOk}
                                onClick={() => save.mutate()}
                                className="h-8 px-4 mb-0.5 rounded-lg text-[11px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
                            >
                                {save.isPending ? "…" : "Save"}
                            </button>
                        </div>
                        {oemPrice != null && (
                            <p className={`text-[11px] ${belowOem ? "font-medium text-rose-600" : "text-gray-500"}`}>
                                OEM price in force: {formatINRExact(oemPrice)}.{" "}
                                {belowOem ? "A list price cannot be below it." : "The list price must be at or above it."}
                            </p>
                        )}
                        {!datesOk && (
                            <p className="text-[11px] font-medium text-rose-600">
                                The end date must be after the start date.
                            </p>
                        )}
                    </div>

                    {isLoading && (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="w-5 h-5 animate-spin text-gray-300" />
                        </div>
                    )}
                    {isError && (
                        <p className="text-sm text-rose-600 py-6 text-center">
                            Couldn&apos;t load the list price schedule.
                        </p>
                    )}
                    {data && data.length === 0 && (
                        <p className="text-sm text-gray-400 italic py-4 text-center">
                            No list price has been set — quotations print the OEM price as list
                            price.
                        </p>
                    )}
                    {data && data.length > 0 && (
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
                                    <th className="py-2 px-2 font-semibold text-right">List price</th>
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
                                    const busy = remove.isPending && remove.variables === line.price_id;
                                    return (
                                        <tr key={line.price_id} className="border-b border-gray-50 align-top">
                                            <td className="py-2 px-2 text-right tabular-nums font-semibold text-gray-900">
                                                {formatINRExact(line.list_price)}
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
                                            <td className="py-2 px-2 text-gray-500">{line.note || "—"}</td>
                                            <td className="py-2 px-2 text-right">
                                                {state === "scheduled" && (
                                                    <button
                                                        type="button"
                                                        title="Remove this scheduled list price"
                                                        disabled={busy}
                                                        onClick={() => remove.mutate(line.price_id)}
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

function Field({
    label,
    hint,
    children,
}: {
    label: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <label className="block">
            <span className="block text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-1">
                {label}
                {hint && <span className="normal-case font-normal text-gray-400"> · {hint}</span>}
            </span>
            {children}
        </label>
    );
}
