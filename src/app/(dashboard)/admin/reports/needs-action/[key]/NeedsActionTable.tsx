"use client";

// Tracker ID 88 #3 — the rows behind a "Needs action now" tile, with call,
// assign and reassign on the row. Reuses the admin BulkActionBar (real user picker,
// /api/admin/leads/bulk) exactly as Needs Attention and Ready to Assign do:
// tick rows for a batch, or press a row's Assign / Reassign to open the picker
// for that one lead. A lead that leaves the tile's rule drops off on refresh.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Phone } from "lucide-react";
import { BulkActionBar } from "@/app/(dashboard)/admin/_components/BulkActionBar";
import type { ActionRow } from "@/lib/dashboard/salesHeadActions";
import { SortableTh, sortRows, useUrlTableSort, type SortSpec } from "@/components/shared/TableSort";

// ID 243 — header sort over the tile's rows (one capped list, no paging),
// kept in the page link (?sort=&dir=) so Back from a lead keeps the order.
const ACTION_SORT: SortSpec<ActionRow>[] = [
    { key: "dealer", type: "text" },
    { key: "location", type: "text", value: (r) => [r.city, r.state].filter(Boolean).join(", ") },
    { key: "owner", type: "text", value: (r) => r.owner_name },
    { key: "why", type: "text", value: (r) => r.detail },
    { key: "value", type: "number" },
];

const inr = (n: number) =>
    n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(2)} L` : `₹${Math.round(n).toLocaleString("en-IN")}`;

// 24 Nov: no phone-app (tel:) dialling from the CRM — calls go through NeoDove
// so they are recorded and tracked. The button only shows the number and
// copies it; the call itself is placed from the lead's page (Call now).
function CallLink({ phone }: { phone: string }) {
    const [shown, setShown] = useState<"" | "copied" | "shown">("");
    return (
        <button
            type="button"
            title={`Show ${phone}`}
            onClick={() => {
                setShown("shown");
                navigator.clipboard?.writeText(phone).then(
                    () => setShown("copied"),
                    () => {},
                );
            }}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink hover:bg-bg"
        >
            <Phone className="h-3 w-3" aria-hidden />
            {shown ? (
                <>
                    <span className="tabular-nums">{phone}</span>
                    {shown === "copied" && <span className="text-ink-muted">· copied</span>}
                </>
            ) : (
                "Number"
            )}
        </button>
    );
}

export function NeedsActionTable({
    rows: rowsIn,
    phones,
    ownerHeading,
    hasValue,
    canAssign,
}: {
    rows: ActionRow[];
    /** ID 88 #3 — lead id → the dealer's phone, for the row's Call button. */
    phones: Record<string, string>;
    ownerHeading: string;
    hasValue: boolean;
    /** The viewer is in the bulk route's role list; others only read. */
    canAssign: boolean;
}) {
    const router = useRouter();
    const { sort, toggle: toggleSort, comparator } = useUrlTableSort(ACTION_SORT);
    const rows = sortRows(rowsIn, comparator);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [reassignSignal, setReassignSignal] = useState(0);
    const toggle = (id: string) =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.lead_id));

    return (
        <div className="space-y-3">
            {canAssign && (
                <div className="flex min-h-[44px] flex-wrap items-center gap-3 rounded-xl border border-dashed border-border px-3 py-2 text-sm">
                    {selected.size > 0 ? (
                        <BulkActionBar
                            selectedIds={[...selected]}
                            onClear={() => setSelected(new Set())}
                            onActionDone={() => {
                                setSelected(new Set());
                                router.refresh();
                            }}
                            reassignSignal={reassignSignal}
                        />
                    ) : (
                        <span className="text-ink-muted">
                            <span className="font-semibold text-ink">Assign or reassign:</span> press a row&apos;s button, or tick several
                            leads for a batch.
                        </span>
                    )}
                </div>
            )}
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                        <tr>
                            {canAssign && (
                                <th className="w-10 px-4 py-3">
                                    <input
                                        type="checkbox"
                                        aria-label="Select every lead shown"
                                        checked={allSelected}
                                        onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.lead_id)))}
                                    />
                                </th>
                            )}
                            <SortableTh label="Dealer" sortKey="dealer" sort={sort} onToggle={toggleSort} className="px-4 py-3" />
                            <SortableTh label="Location" sortKey="location" sort={sort} onToggle={toggleSort} className="px-4 py-3" />
                            <SortableTh label={ownerHeading} sortKey="owner" sort={sort} onToggle={toggleSort} className="px-4 py-3" />
                            <SortableTh label="Why it is here" sortKey="why" sort={sort} onToggle={toggleSort} className="px-4 py-3" />
                            {hasValue && <SortableTh label="Value" sortKey="value" sort={sort} onToggle={toggleSort} align="right" className="px-4 py-3 text-right" />}
                            <th className="px-4 py-3 text-right">Action</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {rows.map((r) => (
                            <tr key={r.lead_id} className="align-top">
                                {canAssign && (
                                    <td className="px-4 py-3">
                                        <input
                                            type="checkbox"
                                            aria-label={`Select ${r.dealer}`}
                                            checked={selected.has(r.lead_id)}
                                            onChange={() => toggle(r.lead_id)}
                                        />
                                    </td>
                                )}
                                <td className="px-4 py-3">
                                    <Link
                                        href={r.href ?? `/inside-sales/lead/${encodeURIComponent(r.lead_id)}`}
                                        className="font-medium text-gray-900 hover:text-brand-sky hover:underline"
                                    >
                                        {r.dealer}
                                    </Link>
                                </td>
                                <td className="px-4 py-3 text-gray-700">{[r.city, r.state].filter(Boolean).join(", ") || "—"}</td>
                                <td className="px-4 py-3 text-gray-700">{r.owner_name ?? "—"}</td>
                                <td className="px-4 py-3 text-gray-700">{r.detail}</td>
                                {hasValue && (
                                    <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums text-gray-900">
                                        {r.value == null ? "—" : inr(r.value)}
                                    </td>
                                )}
                                <td className="whitespace-nowrap px-4 py-3 text-right">
                                    <div className="inline-flex items-center gap-1.5">
                                        {/* ID 88 #3 — no number, no button. */}
                                        {phones[r.lead_id] && <CallLink phone={phones[r.lead_id]} />}
                                        {canAssign && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setSelected(new Set([r.lead_id]));
                                                    setReassignSignal((n) => n + 1);
                                                }}
                                                className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink hover:bg-bg"
                                            >
                                                {r.owner_id ? "Reassign" : "Assign"}
                                            </button>
                                        )}
                                        {!phones[r.lead_id] && !canAssign && <span className="text-xs text-ink-muted">—</span>}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
