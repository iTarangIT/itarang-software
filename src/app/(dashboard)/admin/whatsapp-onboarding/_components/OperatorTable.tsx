"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OperatorRow } from "./types";

export function OperatorTable({
    operators,
    loading,
    canWrite,
    selectedId,
    onSelect,
    onChanged,
}: {
    operators: OperatorRow[];
    loading: boolean;
    canWrite: boolean;
    selectedId: string | null;
    onSelect: (o: OperatorRow) => void;
    onChanged: () => void;
}) {
    const [busyId, setBusyId] = useState<string | null>(null);

    async function toggleActive(op: OperatorRow) {
        setBusyId(op.id);
        try {
            const res = await fetch(`/api/admin/whatsapp-operators/${op.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ isActive: !op.isActive }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(json?.error?.message || "Update failed");
            }
            toast.success(
                op.isActive
                    ? `${op.displayName} can no longer onboard from WhatsApp`
                    : `${op.displayName} re-activated`,
            );
            onChanged();
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : "Couldn't update this operator",
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

    if (operators.length === 0) {
        return (
            <div className="px-4 py-10 text-center text-sm text-ink-muted">
                No onboarding operators yet.
                <br />
                Add a team member&apos;s WhatsApp number to let them onboard
                dealers from their own phone.
            </div>
        );
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-ink-muted border-b border-border">
                        <th className="px-4 py-2 font-medium">Team member</th>
                        <th className="px-4 py-2 font-medium">WhatsApp</th>
                        <th className="px-4 py-2 font-medium text-right">
                            In progress
                        </th>
                        <th className="px-4 py-2 font-medium text-right">
                            Submitted
                        </th>
                        <th className="px-4 py-2 font-medium text-right">
                            Approved
                        </th>
                        <th className="px-4 py-2 font-medium">Status</th>
                        <th className="px-4 py-2" />
                    </tr>
                </thead>
                <tbody>
                    {operators.map((op) => (
                        <tr
                            key={op.id}
                            onClick={() => onSelect(op)}
                            className={`border-b border-border last:border-0 cursor-pointer transition-colors ${
                                selectedId === op.id
                                    ? "bg-surface-muted"
                                    : "hover:bg-surface-muted/60"
                            }`}
                        >
                            <td className="px-4 py-2.5">
                                <div className="font-medium text-ink">
                                    {op.displayName}
                                </div>
                                {op.email && (
                                    <div className="text-xs text-ink-muted">
                                        {op.email}
                                    </div>
                                )}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-xs text-ink">
                                +{op.waPhone}
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums">
                                {op.counts.draft}
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums">
                                {op.counts.submitted}
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums">
                                {op.counts.approved}
                            </td>
                            <td className="px-4 py-2.5">
                                <span
                                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                                        op.isActive
                                            ? "bg-success/10 text-success"
                                            : "bg-ink-muted/10 text-ink-muted"
                                    }`}
                                >
                                    {op.isActive ? "Active" : "Deactivated"}
                                </span>
                            </td>
                            <td
                                className="px-4 py-2.5 text-right"
                                onClick={(e) => e.stopPropagation()}
                            >
                                {canWrite && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={busyId === op.id}
                                        onClick={() => toggleActive(op)}
                                    >
                                        {busyId === op.id ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : op.isActive ? (
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
