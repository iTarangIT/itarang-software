"use client";

/**
 * E-230 — OEM Inventory Pricing.
 *
 * The register the quotation gate reads. Requirement, in the words it was given
 * in (docs/quotation-approval-flow.md §3): pick a category — battery, charger,
 * paraphernalia — pick a model we hold in inventory, set a price, and give that
 * price a validity period. One price is active per model at a time; to change
 * it you ADD A LINE starting after the current one ends.
 *
 * Three things on this screen are load-bearing rather than decorative:
 *
 *   Unpriced products lead.       Each one forces every quote containing it to
 *                                 the CEO, so working that list down is the
 *                                 fastest way to get value out of the feature.
 *   Expiring prices are called    A window closing with nothing queued behind
 *   out before they lapse.        it means the product silently stops
 *                                 auto-approving on that date. That is the
 *                                 failure the notification exists to prevent
 *                                 and this is where it gets fixed.
 *   Nothing is edited in place.   Saving adds a line. The price a past quote
 *                                 was judged against stays on the record.
 */

import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, History, Loader2, Search, Tag } from "lucide-react";
import { formatINRExact } from "@/lib/format";
import { Pagination, usePagination } from "@/components/shared/Pagination";
import {
    SortableTh,
    sortRows,
    useTableSort,
    type SortSpec,
} from "@/components/shared/TableSort";
import { OemPriceScheduleDrawer } from "./OemPriceScheduleDrawer";

export interface OemCatalogueRow {
    asset_type: "battery" | "charger" | "paraphernalia";
    product_id: string;
    model_id: string;
    product_name: string;
    detail: string | null;
    oem_price: number | null;
    price_id: string | null;
    effective_from: string | null;
    valid_until: string | null;
    set_by_name: string | null;
    note: string | null;
    next_price: number | null;
    next_price_id: string | null;
    next_effective_from: string | null;
    next_valid_until: string | null;
}

interface CatalogueResponse {
    products: OemCatalogueRow[];
    unpriced: number;
    expiring: number;
    total: number;
}

const ASSET_LABEL: Record<OemCatalogueRow["asset_type"], string> = {
    battery: "Battery",
    charger: "Charger",
    paraphernalia: "Paraphernalia",
};

/** Matches the API's `expiring` count — one fortnight's notice. */
const EXPIRY_WARNING_DAYS = 14;

const SORT_SPECS: SortSpec<OemCatalogueRow>[] = [
    { key: "product_name", type: "text" },
    { key: "model_id", type: "text" },
    { key: "asset_type", type: "text", value: (r) => ASSET_LABEL[r.asset_type] },
    // Unpriced rows sort as empty, which tableSortCore already pushes to the
    // end — so sorting by price never buries the rows that need attention
    // among real numbers.
    { key: "oem_price", type: "number" },
    { key: "valid_until", type: "date" },
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

/**
 * An instant as the YYYY-MM-DD the date picker wants, read in IST.
 *
 * Deliberately not `toISOString().slice(0,10)`: the API writes IST midnight, so
 * a 1 August window start is 2026-07-31T18:30Z and the naive slice would
 * pre-fill the picker with 31 July — a whole day early, every time.
 */
function toDayInput(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function todayInput(): string {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// `now` is threaded in rather than read from the clock here: these run during
// render, and re-reading Date.now() on every render is impure and makes the
// "days left" badge unstable for no benefit.
function daysUntil(iso: string | null, now: number): number | null {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return null;
    return Math.ceil((t - now) / 86_400_000);
}

/**
 * Is this row's price about to lapse with nothing behind it?
 * A queued successor makes it a non-event, which is why `next_price` is part of
 * the test rather than just the date.
 */
function isLapsing(row: OemCatalogueRow, now: number): boolean {
    if (row.oem_price == null || !row.valid_until || row.next_price != null) return false;
    const d = daysUntil(row.valid_until, now);
    return d != null && d >= 0 && d <= EXPIRY_WARNING_DAYS;
}

type EditMode = "revise" | "schedule";

interface Draft {
    key: string;
    mode: EditMode;
    price: string;
    from: string;
    until: string;
    note: string;
}

export function OemInventoryPricing() {
    const qc = useQueryClient();
    const [assetFilter, setAssetFilter] = React.useState<
        "all" | OemCatalogueRow["asset_type"]
    >("all");
    const [attentionOnly, setAttentionOnly] = React.useState(false);
    const [search, setSearch] = React.useState("");
    const [draft, setDraft] = React.useState<Draft | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [scheduleFor, setScheduleFor] = React.useState<OemCatalogueRow | null>(null);
    // One clock reading per mount — see daysUntil above.
    const [now] = React.useState(() => Date.now());

    const { data, isLoading, isError } = useQuery<CatalogueResponse>({
        queryKey: ["oem-pricing-catalogue"],
        queryFn: async () => {
            const r = await fetch("/api/dashboard/ceo/oem-prices", { cache: "no-store" });
            if (!r.ok) throw new Error("Failed to load the price book");
            return (await r.json()).data as CatalogueResponse;
        },
    });

    const save = useMutation({
        mutationFn: async (vars: { row: OemCatalogueRow; draft: Draft }) => {
            const r = await fetch("/api/dashboard/ceo/oem-prices", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    asset_type: vars.row.asset_type,
                    product_id: vars.row.product_id,
                    oem_price: Number(vars.draft.price),
                    // Blank start means "now" — an ordinary revision. The API
                    // decides revision-vs-queued from this date alone.
                    effective_from: vars.draft.from || null,
                    valid_until: vars.draft.until || null,
                    note: vars.draft.note.trim() || null,
                }),
            });
            const j = await r.json().catch(() => null);
            if (!r.ok) throw new Error(j?.error?.message ?? "Could not save the price");
            return j.data;
        },
        onSuccess: () => {
            setDraft(null);
            setError(null);
            qc.invalidateQueries({ queryKey: ["oem-pricing-catalogue"] });
            qc.invalidateQueries({ queryKey: ["oem-price-schedule"] });
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
            // One filter for "this row needs me": never priced, or about to run
            // out with nothing queued. Both block auto-approval, one now and
            // one on a known date.
            if (attentionOnly && !(p.oem_price == null || isLapsing(p, now))) return false;
            if (!q) return true;
            return (
                p.product_name.toLowerCase().includes(q) ||
                p.model_id.toLowerCase().includes(q)
            );
        });
    }, [products, assetFilter, attentionOnly, search, now]);

    const { sort, toggle, comparator } = useTableSort<OemCatalogueRow>(SORT_SPECS);
    const sorted = React.useMemo(() => sortRows(filtered, comparator), [filtered, comparator]);
    const paged = usePagination(sorted, 15);

    function beginEdit(row: OemCatalogueRow, mode: EditMode) {
        setError(null);
        setDraft({
            key: rowKey(row),
            mode,
            price:
                mode === "schedule"
                    ? ""
                    : row.oem_price != null
                      ? String(row.oem_price)
                      : "",
            // Scheduling starts the day the current window closes, which is the
            // only start that cannot overlap it. Revising starts today.
            from: mode === "schedule" ? toDayInput(row.valid_until) : todayInput(),
            until: mode === "schedule" ? "" : toDayInput(row.valid_until),
            note: "",
        });
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

    const unpriced = data?.unpriced ?? 0;
    const expiring = data?.expiring ?? 0;

    return (
        <Shell unpriced={unpriced} total={data?.total ?? 0}>
            {unpriced > 0 && (
                <p className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-2">
                    {unpriced} of {data?.total} models have no reference price in force.
                    Every quote containing one of them goes to the approval queue.
                </p>
            )}
            {expiring > 0 && (
                <p className="text-[11px] font-medium text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 mb-2">
                    {expiring} price{expiring === 1 ? "" : "s"} lapse within{" "}
                    {EXPIRY_WARNING_DAYS} days with nothing scheduled behind{" "}
                    {expiring === 1 ? "it" : "them"}. Add the next line before the window
                    closes, or those models stop auto-approving.
                </p>
            )}
            {error && (
                <p className="text-[11px] font-medium text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 mb-2">
                    {error}
                </p>
            )}

            <div className="flex items-center gap-2 mb-3 flex-wrap">
                <div className="relative">
                    <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Model name or model ID"
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
                    onClick={() => setAttentionOnly((v) => !v)}
                    className={`h-8 px-3 rounded-lg text-[11px] font-semibold transition-colors ${
                        attentionOnly
                            ? "bg-amber-500 text-white"
                            : "border border-gray-200 text-gray-600 hover:bg-gray-50"
                    }`}
                >
                    Needs a price
                </button>
            </div>

            {sorted.length === 0 ? (
                <p className="text-sm text-gray-400 italic py-8 text-center">
                    No models match these filters.
                </p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
                                <SortableTh label="Model" sortKey="product_name" sort={sort} onToggle={toggle} />
                                <SortableTh label="Model ID" sortKey="model_id" sort={sort} onToggle={toggle} />
                                <SortableTh label="Category" sortKey="asset_type" sort={sort} onToggle={toggle} />
                                <SortableTh label="OEM Price" sortKey="oem_price" sort={sort} onToggle={toggle} align="right" />
                                <SortableTh label="Valid Until" sortKey="valid_until" sort={sort} onToggle={toggle} />
                                <th className="py-2 px-2 font-semibold">Next Scheduled</th>
                                <SortableTh label="Set By" sortKey="set_by_name" sort={sort} onToggle={toggle} />
                                <th className="py-2 px-2 font-semibold text-right" />
                            </tr>
                        </thead>
                        <tbody>
                            {paged.pageItems.map((row) => {
                                const key = rowKey(row);
                                const editing = draft?.key === key ? draft : null;
                                const busy =
                                    save.isPending && rowKey(save.variables!.row) === key;
                                const lapsing = isLapsing(row, now);
                                const left = daysUntil(row.valid_until, now);

                                return (
                                    <React.Fragment key={key}>
                                        <tr className="border-b border-gray-50 align-top">
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
                                            <td className="py-2 px-2 text-gray-600">
                                                {row.model_id}
                                            </td>
                                            <td className="py-2 px-2 text-gray-600">
                                                {ASSET_LABEL[row.asset_type]}
                                            </td>
                                            <td className="py-2 px-2 text-right tabular-nums">
                                                {row.oem_price != null ? (
                                                    <span className="font-semibold text-gray-900">
                                                        {formatINRExact(row.oem_price)}
                                                    </span>
                                                ) : (
                                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                                                        not set
                                                    </span>
                                                )}
                                            </td>
                                            <td className="py-2 px-2 whitespace-nowrap">
                                                {row.oem_price == null ? (
                                                    <span className="text-gray-400">—</span>
                                                ) : row.valid_until ? (
                                                    <span
                                                        className={
                                                            lapsing
                                                                ? "font-semibold text-rose-600"
                                                                : "text-gray-600"
                                                        }
                                                    >
                                                        {fmtDate(row.valid_until)}
                                                        {lapsing && left != null && (
                                                            <span className="block text-[10px] font-bold text-rose-500">
                                                                {left === 0
                                                                    ? "lapses today"
                                                                    : `${left}d left`}
                                                            </span>
                                                        )}
                                                    </span>
                                                ) : (
                                                    <span className="text-[10px] text-gray-400">
                                                        open-ended
                                                    </span>
                                                )}
                                            </td>
                                            <td className="py-2 px-2 whitespace-nowrap">
                                                {row.next_price != null ? (
                                                    <span className="text-gray-700 tabular-nums">
                                                        {formatINRExact(row.next_price)}
                                                        <span className="block text-[10px] text-blue-600 font-medium">
                                                            from {fmtDate(row.next_effective_from)}
                                                        </span>
                                                    </span>
                                                ) : (
                                                    <span className="text-gray-300">—</span>
                                                )}
                                            </td>
                                            <td className="py-2 px-2 text-gray-600">
                                                {row.set_by_name ?? "—"}
                                            </td>
                                            <td className="py-2 px-2 text-right whitespace-nowrap">
                                                <button
                                                    type="button"
                                                    onClick={() => beginEdit(row, "revise")}
                                                    className="h-7 px-3 rounded-lg text-[11px] font-bold border border-gray-200 text-gray-600 hover:bg-gray-50"
                                                >
                                                    {row.oem_price != null ? "Revise" : "Set price"}
                                                </button>
                                                {/* Queueing a successor needs an end date on
                                                    the line in force — otherwise there is no
                                                    instant it could legally start at. */}
                                                <button
                                                    type="button"
                                                    title={
                                                        row.valid_until
                                                            ? "Schedule the next price"
                                                            : "Give the current price an end date first"
                                                    }
                                                    disabled={!row.valid_until || row.next_price != null}
                                                    onClick={() => beginEdit(row, "schedule")}
                                                    className="h-7 px-2 ml-1 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-30 disabled:hover:bg-transparent"
                                                >
                                                    <CalendarClock className="w-3.5 h-3.5 inline" />
                                                </button>
                                                <button
                                                    type="button"
                                                    title="Price schedule and history"
                                                    onClick={() => setScheduleFor(row)}
                                                    className="h-7 px-2 ml-1 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                                                >
                                                    <History className="w-3.5 h-3.5 inline" />
                                                </button>
                                            </td>
                                        </tr>

                                        {editing && (
                                            <tr className="border-b border-gray-100 bg-gray-50/60">
                                                <td colSpan={8} className="py-3 px-2">
                                                    <PriceEditor
                                                        row={row}
                                                        draft={editing}
                                                        busy={busy}
                                                        onChange={setDraft}
                                                        onCancel={() => setDraft(null)}
                                                        onSave={() =>
                                                            save.mutate({ row, draft: editing })
                                                        }
                                                    />
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
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
                noun="models"
            />

            {scheduleFor && (
                <OemPriceScheduleDrawer
                    assetType={scheduleFor.asset_type}
                    productId={scheduleFor.product_id}
                    productName={scheduleFor.product_name}
                    onClose={() => setScheduleFor(null)}
                />
            )}
        </Shell>
    );
}

/**
 * The line being added, expanded under its row.
 *
 * A form rather than four boxes squeezed into table cells: the dates are the
 * point of this screen and a date typed into a 90px cell is how you get a price
 * that lapses in the wrong month.
 */
function PriceEditor({
    row,
    draft,
    busy,
    onChange,
    onCancel,
    onSave,
}: {
    row: OemCatalogueRow;
    draft: Draft;
    busy: boolean;
    onChange: (d: Draft) => void;
    onCancel: () => void;
    onSave: () => void;
}) {
    const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
    const scheduling = draft.mode === "schedule";

    const priceOk = isValidPrice(draft.price);
    const datesOk =
        !draft.from || !draft.until || new Date(draft.until) > new Date(draft.from);
    // A queued line with no start would be written as "now", silently
    // superseding the price it was meant to follow.
    const startOk = !scheduling || !!draft.from;

    return (
        <div className="space-y-2">
            <p className="text-[11px] font-semibold text-gray-700">
                {scheduling
                    ? `Schedule the next price for ${row.product_name}`
                    : row.oem_price != null
                      ? `Revise the price for ${row.product_name}`
                      : `Set the price for ${row.product_name}`}
                {scheduling && (
                    <span className="font-normal text-gray-500">
                        {" "}
                        — it takes over when the current window closes.
                    </span>
                )}
            </p>

            <div className="flex flex-wrap items-end gap-3">
                <Field label="OEM price (₹)">
                    <input
                        autoFocus
                        type="number"
                        min={0}
                        step="0.01"
                        value={draft.price}
                        onChange={(e) => set({ price: e.target.value })}
                        className="h-8 w-32 px-2 text-right rounded-lg border border-gray-200 text-xs outline-none focus:border-brand-300"
                    />
                </Field>
                <Field label="Valid from">
                    <input
                        type="date"
                        value={draft.from}
                        onChange={(e) => set({ from: e.target.value })}
                        className="h-8 w-36 px-2 rounded-lg border border-gray-200 text-xs outline-none focus:border-brand-300"
                    />
                </Field>
                <Field label="Valid until" hint="blank = open-ended">
                    <input
                        type="date"
                        value={draft.until}
                        min={draft.from || undefined}
                        onChange={(e) => set({ until: e.target.value })}
                        className="h-8 w-36 px-2 rounded-lg border border-gray-200 text-xs outline-none focus:border-brand-300"
                    />
                </Field>
                <Field label="Note" hint="optional">
                    <input
                        value={draft.note}
                        onChange={(e) => set({ note: e.target.value })}
                        placeholder="e.g. OEM circular of 28 Jul"
                        className="h-8 w-56 px-2 rounded-lg border border-gray-200 text-xs outline-none focus:border-brand-300"
                    />
                </Field>

                <div className="flex items-center gap-1 pb-0.5">
                    <button
                        type="button"
                        disabled={busy || !priceOk || !datesOk || !startOk}
                        onClick={onSave}
                        className="h-8 px-4 rounded-lg text-[11px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
                    >
                        {busy ? "…" : scheduling ? "Schedule" : "Save"}
                    </button>
                    <button
                        type="button"
                        onClick={onCancel}
                        className="h-8 px-3 rounded-lg text-[11px] font-semibold text-gray-500 hover:bg-gray-100"
                    >
                        Cancel
                    </button>
                </div>
            </div>

            {!datesOk && (
                <p className="text-[11px] font-medium text-rose-600">
                    The end date must be after the start date.
                </p>
            )}
            {!draft.until && !scheduling && (
                <p className="text-[11px] text-gray-500">
                    With no end date this price stays the reference until something
                    replaces it — and nothing will warn you to review it.
                </p>
            )}
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
            data-testid="oem-inventory-pricing"
            className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm"
        >
            <div className="flex items-center gap-2 mb-4">
                <Tag className="w-4 h-4 text-gray-400" />
                <h3 className="text-sm font-semibold text-gray-900">Pricing register</h3>
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
