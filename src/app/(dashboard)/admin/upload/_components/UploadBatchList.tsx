"use client";

// BRD §0.4 — recent upload batches with the 24h rollback / restore controls.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, RotateCcw, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { UploadBatchSummary } from "@/lib/admin/types";

function fmt(iso: string | null): string {
    if (!iso) return "—";
    try {
        return new Date(iso).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return "—";
    }
}

export function UploadBatchList() {
    const qc = useQueryClient();
    const [busyId, setBusyId] = useState<string | null>(null);

    const query = useQuery<{
        success: true;
        data: { batches: UploadBatchSummary[] };
    }>({
        queryKey: ["admin-upload-batches"],
        queryFn: async () => {
            const res = await fetch("/api/admin/upload/batches", {
                cache: "no-store",
            });
            if (!res.ok) throw new Error("Failed to load batches");
            return res.json();
        },
    });
    const batches = query.data?.data.batches ?? [];

    async function act(batchId: string, kind: "rollback" | "restore") {
        setBusyId(batchId);
        try {
            const res = await fetch(`/api/admin/upload/${batchId}/${kind}`, {
                method: "POST",
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Action failed");
            }
            toast.success(
                kind === "rollback" ? "Batch rolled back." : "Batch restored.",
            );
            qc.invalidateQueries({ queryKey: ["admin-upload-batches"] });
            qc.invalidateQueries({ queryKey: ["admin-dashboard"] });
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusyId(null);
        }
    }

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="px-4 py-3 border-b border-border">
                <h2 className="text-sm font-semibold text-ink">
                    Recent Batches
                </h2>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="text-left px-4 py-2.5 font-semibold">File</th>
                            <th className="text-left px-4 py-2.5 font-semibold">Rows</th>
                            <th className="text-left px-4 py-2.5 font-semibold">Routing</th>
                            <th className="text-left px-4 py-2.5 font-semibold">Status</th>
                            <th className="text-left px-4 py-2.5 font-semibold">Uploaded</th>
                            <th className="px-4 py-2.5"></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {query.isLoading && (
                            <tr>
                                <td colSpan={6} className="px-4 py-8 text-center text-ink-muted">
                                    <Loader2 className="h-5 w-5 animate-spin mx-auto" />
                                </td>
                            </tr>
                        )}
                        {!query.isLoading && batches.length === 0 && (
                            <tr>
                                <td colSpan={6} className="px-4 py-8 text-center text-ink-muted">
                                    No uploads yet.
                                </td>
                            </tr>
                        )}
                        {batches.map((b) => {
                            const windowOpen =
                                !!b.rollback_window_until &&
                                new Date(b.rollback_window_until).getTime() >
                                    Date.now();
                            const canRollback =
                                b.status === "processed" &&
                                !b.rolled_back_at &&
                                windowOpen;
                            const canRestore = !!b.rolled_back_at;
                            return (
                                <tr key={b.batch_id}>
                                    <td className="px-4 py-2.5">
                                        <div className="font-medium text-ink">
                                            {b.file_name}
                                        </div>
                                        {b.source_label && (
                                            <div className="text-[11px] text-ink-muted">
                                                {b.source_label}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-4 py-2.5 text-xs text-ink-muted">
                                        {b.valid_rows}/{b.total_rows} imported
                                        {b.errored_rows > 0 &&
                                            ` · ${b.errored_rows} errors`}
                                    </td>
                                    <td className="px-4 py-2.5 text-xs text-ink-muted">
                                        {b.routing_to_ai
                                            ? "AI dialer"
                                            : "Direct to queue"}
                                    </td>
                                    <td className="px-4 py-2.5">
                                        <span
                                            className={`text-xs font-medium ${
                                                b.status === "rolled_back"
                                                    ? "text-danger"
                                                    : b.status === "processed"
                                                      ? "text-success"
                                                      : "text-warning"
                                            }`}
                                        >
                                            {b.status}
                                        </span>
                                    </td>
                                    <td className="px-4 py-2.5 text-xs text-ink-muted">
                                        {fmt(b.created_at)}
                                        {b.uploaded_by_name && (
                                            <div className="text-[11px] text-ink-muted">
                                                {b.uploaded_by_name}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-4 py-2.5 text-right">
                                        {canRollback && (
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                disabled={busyId === b.batch_id}
                                                onClick={() =>
                                                    act(b.batch_id, "rollback")
                                                }
                                            >
                                                <Undo2 className="h-3.5 w-3.5 mr-1" />
                                                Rollback
                                            </Button>
                                        )}
                                        {canRestore && (
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                disabled={busyId === b.batch_id}
                                                onClick={() =>
                                                    act(b.batch_id, "restore")
                                                }
                                            >
                                                <RotateCcw className="h-3.5 w-3.5 mr-1" />
                                                Restore
                                            </Button>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
