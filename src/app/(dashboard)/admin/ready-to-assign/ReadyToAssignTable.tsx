"use client";

// Tracker ID 82 — the Ready to assign list, with the assignment itself. The
// lead page has no owner control, so a queue that only linked to it could not
// be worked: tick the leads here and Reassign (BulkActionBar → the same
// /api/admin/leads/bulk every other list assigns through). A lead that gets an
// owner leaves the list on refresh.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BulkActionBar } from "@/app/(dashboard)/admin/_components/BulkActionBar";

export type ReadyToAssignTableRow = {
    id: string;
    dealer_name: string | null;
    location: string;
    status: string;
    interest_level: string | null;
    reason: string;
    days_waiting: number;
};

export function ReadyToAssignTable({
    rows,
    canAssign,
    overdueDays,
}: {
    rows: ReadyToAssignTableRow[];
    /** The viewer may assign (the bulk route's own role list); others only read. */
    canAssign: boolean;
    overdueDays: number;
}) {
    const router = useRouter();
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const toggle = (id: string) =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

    return (
        <div className="space-y-3">
            {canAssign && (
                <div className="flex min-h-9 flex-wrap items-center gap-3">
                    {selected.size > 0 ? (
                        <BulkActionBar
                            selectedIds={[...selected]}
                            onClear={() => setSelected(new Set())}
                            onActionDone={() => {
                                setSelected(new Set());
                                router.refresh();
                            }}
                        />
                    ) : (
                        <p className="text-xs text-gray-500">Tick one or more leads, then choose Reassign to give them an owner.</p>
                    )}
                </div>
            )}
            <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
                <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                        <tr>
                            {canAssign && (
                                <th className="w-8 px-4 py-2">
                                    <input
                                        type="checkbox"
                                        aria-label="Select all"
                                        checked={allSelected}
                                        onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
                                    />
                                </th>
                            )}
                            <th className="px-4 py-2">Dealer</th>
                            <th className="px-4 py-2">Location</th>
                            <th className="px-4 py-2">Status</th>
                            <th className="px-4 py-2">Temperature</th>
                            <th className="px-4 py-2">Sales-ready because</th>
                            <th className="px-4 py-2 text-right">Waiting (days)</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {rows.map((r) => (
                            <tr key={r.id} className="hover:bg-gray-50">
                                {canAssign && (
                                    <td className="px-4 py-2">
                                        <input
                                            type="checkbox"
                                            aria-label={`Select ${r.dealer_name ?? r.id}`}
                                            checked={selected.has(r.id)}
                                            onChange={() => toggle(r.id)}
                                        />
                                    </td>
                                )}
                                <td className="px-4 py-2">
                                    <Link href={`/leads/${encodeURIComponent(r.id)}`} className="font-medium text-blue-700 underline">
                                        {r.dealer_name ?? r.id}
                                    </Link>
                                </td>
                                <td className="px-4 py-2 text-gray-600">{r.location}</td>
                                <td className="px-4 py-2 text-gray-600">{r.status}</td>
                                <td className="px-4 py-2 text-gray-600">{r.interest_level ?? "—"}</td>
                                <td className="px-4 py-2 text-gray-600">{r.reason}</td>
                                <td className={`px-4 py-2 text-right tabular-nums ${r.days_waiting >= overdueDays ? "font-semibold text-rose-700" : ""}`}>
                                    {r.days_waiting}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
