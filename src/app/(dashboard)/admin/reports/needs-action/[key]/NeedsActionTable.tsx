"use client";

// Tracker ID 88 #3 — the rows behind a "Needs action now" tile, with assign /
// reassign on the row. Reuses the admin BulkActionBar (real user picker,
// /api/admin/leads/bulk) exactly as Needs Attention and Ready to Assign do:
// tick rows for a batch, or press a row's Assign / Reassign to open the picker
// for that one lead. A lead that leaves the tile's rule drops off on refresh.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BulkActionBar } from "@/app/(dashboard)/admin/_components/BulkActionBar";
import type { ActionRow } from "@/lib/dashboard/salesHeadActions";

const inr = (n: number) =>
    n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(2)} L` : `₹${Math.round(n).toLocaleString("en-IN")}`;

export function NeedsActionTable({
    rows,
    ownerHeading,
    hasValue,
    canAssign,
}: {
    rows: ActionRow[];
    ownerHeading: string;
    hasValue: boolean;
    /** The viewer is in the bulk route's role list; others only read. */
    canAssign: boolean;
}) {
    const router = useRouter();
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
                            <th className="px-4 py-3">Dealer</th>
                            <th className="px-4 py-3">Location</th>
                            <th className="px-4 py-3">{ownerHeading}</th>
                            <th className="px-4 py-3">Why it is here</th>
                            {hasValue && <th className="px-4 py-3 text-right">Value</th>}
                            {canAssign && <th className="px-4 py-3 text-right">Action</th>}
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
                                        href={`/inside-sales/lead/${encodeURIComponent(r.lead_id)}`}
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
                                {canAssign && (
                                    <td className="px-4 py-3 text-right">
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
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
