"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ExtraNumberRow } from "./MultiDealerNumbersView";

export function ExtraNumberTable({
    numbers,
    loading,
    canWrite,
    onChanged,
}: {
    numbers: ExtraNumberRow[];
    loading: boolean;
    canWrite: boolean;
    onChanged: () => void;
}) {
    const [busyId, setBusyId] = useState<string | null>(null);

    async function toggleActive(row: ExtraNumberRow) {
        setBusyId(row.id);
        try {
            const res = await fetch(
                `/api/admin/dealer-extra-numbers/${row.id}`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ isActive: !row.isActive }),
                },
            );
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(json?.error?.message || "Update failed");
            }
            toast.success(
                row.isActive
                    ? `+${row.waPhone} no longer opens the dealer console`
                    : `+${row.waPhone} re-activated`,
            );
            onChanged();
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : "Couldn't update this number",
            );
        } finally {
            setBusyId(null);
        }
    }

    if (loading) {
        return (
            <div className="px-4 py-10 flex items-center justify-center text-ink-muted">
                <Loader2 className="h-5 w-5 animate-spin" />
            </div>
        );
    }

    if (numbers.length === 0) {
        return (
            <div className="px-4 py-10 text-center text-sm text-ink-muted">
                No extra dealer numbers yet.
                <br />
                Add a WhatsApp number to let more people act as the main dealer
                of a dealership.
            </div>
        );
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-ink-muted border-b border-border">
                        <th className="px-4 py-2 font-medium">Dealer</th>
                        <th className="px-4 py-2 font-medium">Label</th>
                        <th className="px-4 py-2 font-medium">WhatsApp</th>
                        <th className="px-4 py-2 font-medium">Status</th>
                        <th className="px-4 py-2 font-medium">Added</th>
                        <th className="px-4 py-2" />
                    </tr>
                </thead>
                <tbody>
                    {numbers.map((row) => (
                        <tr
                            key={row.id}
                            className="border-b border-border last:border-0"
                        >
                            <td className="px-4 py-2.5">
                                <div className="font-medium text-ink">
                                    {row.dealerName || row.dealerCode}
                                </div>
                                {row.dealerName && (
                                    <div className="text-xs text-ink-muted">
                                        {row.dealerCode}
                                    </div>
                                )}
                            </td>
                            <td className="px-4 py-2.5 text-ink">
                                {row.displayName}
                                {row.notes && (
                                    <div className="text-xs text-ink-muted">
                                        {row.notes}
                                    </div>
                                )}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-xs text-ink">
                                +{row.waPhone}
                            </td>
                            <td className="px-4 py-2.5">
                                <span
                                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                                        row.isActive
                                            ? "bg-success/10 text-success"
                                            : "bg-ink-muted/10 text-ink-muted"
                                    }`}
                                >
                                    {row.isActive ? "Active" : "Deactivated"}
                                </span>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-ink-muted whitespace-nowrap">
                                {new Date(row.createdAt).toLocaleDateString(
                                    "en-IN",
                                    {
                                        day: "numeric",
                                        month: "short",
                                        year: "numeric",
                                    },
                                )}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                                {canWrite && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={busyId === row.id}
                                        onClick={() => toggleActive(row)}
                                    >
                                        {busyId === row.id ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : row.isActive ? (
                                            "Deactivate"
                                        ) : (
                                            "Re-activate"
                                        )}
                                    </Button>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
