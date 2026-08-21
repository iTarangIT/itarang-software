"use client";

// BRD §0.11 — admin bulk actions on selected leads. Surfaces when leads are
// checked in the alert panels. Desktop-only (mobile is read-only in V1).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
    Download,
    FileSpreadsheet,
    Loader2,
    Repeat,
    X,
    XCircle,
} from "lucide-react";
import { Modal } from "@/app/(dashboard)/inside-sales/_components/Modal";
import { Button } from "@/components/ui/button";
import {
    HIGH_IMPACT_LOST_REASONS,
    LOST_REASON,
} from "@/lib/lifecycle/transitions";
import type { UserOption } from "@/lib/admin/types";

type Mode = null | "reassign" | "mark_lost";

export function BulkActionBar({
    selectedIds,
    onClear,
    onActionDone,
}: {
    selectedIds: string[];
    onClear: () => void;
    onActionDone: () => void;
}) {
    const [mode, setMode] = useState<Mode>(null);
    const [targetUserId, setTargetUserId] = useState("");
    const [lostReason, setLostReason] = useState<string>(LOST_REASON[0]);
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    // Which download is in flight, so the spinner lands on the button that was
    // actually clicked — `busy` alone is shared with the modal and would spin
    // both export buttons at once.
    const [downloading, setDownloading] = useState<
        null | "export" | "export_touchpoints"
    >(null);

    const usersQuery = useQuery<{ success: true; data: { users: UserOption[] } }>({
        queryKey: ["admin-user-options"],
        enabled: mode === "reassign",
        queryFn: async () => {
            const res = await fetch("/api/admin/users", { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load users");
            return res.json();
        },
        staleTime: 5 * 60 * 1000,
    });
    const users = usersQuery.data?.data.users ?? [];

    const highImpact = (HIGH_IMPACT_LOST_REASONS as readonly string[]).includes(
        lostReason,
    );

    // Both exports are the same download: POST the selection, take the file
    // back as a blob, hand it to a synthetic anchor. The response also carries
    // Content-Disposition, but with a blob: URL the client-side `download`
    // attribute is what names the saved file.
    async function downloadExport(
        action: "export" | "export_touchpoints",
        filename: string,
    ) {
        setBusy(true);
        setDownloading(action);
        try {
            const res = await fetch("/api/admin/leads/bulk", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action, lead_ids: selectedIds }),
            });
            if (!res.ok) {
                // Failures come back as JSON (withErrorHandler), successes as a
                // file — so only try to read a message when it isn't the file.
                let message = "Export failed";
                try {
                    const json = await res.json();
                    message = json?.error?.message ?? message;
                } catch {
                    /* non-JSON body — keep the generic message */
                }
                throw new Error(message);
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            toast.success(
                `Downloaded ${filename} — ${selectedIds.length} lead${
                    selectedIds.length === 1 ? "" : "s"
                }.`,
            );
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
            setDownloading(null);
        }
    }

    async function submit() {
        if (mode === "reassign" && !targetUserId) {
            toast.error("Pick a user to reassign to.");
            return;
        }
        if (reason.trim().length < 5) {
            toast.error("Enter a reason (min 5 characters).");
            return;
        }
        setBusy(true);
        try {
            const res = await fetch("/api/admin/leads/bulk", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: mode,
                    lead_ids: selectedIds,
                    target_user_id:
                        mode === "reassign" ? targetUserId : undefined,
                    lost_reason: mode === "mark_lost" ? lostReason : undefined,
                    reason: reason.trim(),
                }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Bulk action failed");
            }
            toast.success(
                `Done — ${json.data.affected} updated${
                    json.data.skipped ? `, ${json.data.skipped} skipped` : ""
                }.`,
            );
            setMode(null);
            setReason("");
            setTargetUserId("");
            onActionDone();
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <div className="hidden md:flex items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2">
                <span className="text-sm font-semibold text-brand-800">
                    {selectedIds.length} selected
                </span>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setMode("reassign")}
                >
                    <Repeat className="h-3.5 w-3.5 mr-1" />
                    Reassign
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setMode("mark_lost")}
                >
                    <XCircle className="h-3.5 w-3.5 mr-1" />
                    Mark Lost
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => downloadExport("export", "leads_export.csv")}
                    disabled={busy}
                >
                    {downloading === "export" ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                        <Download className="h-3.5 w-3.5 mr-1" />
                    )}
                    Export CSV
                </Button>
                {/* The CSV above is the lead ROWS. This is their activity log —
                    every touchpoint and status change of every selected lead,
                    in one workbook. */}
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                        downloadExport(
                            "export_touchpoints",
                            "lead_touchpoint_history.xlsx",
                        )
                    }
                    disabled={busy}
                    title="Download the touchpoint history of every selected lead as an Excel workbook"
                >
                    {downloading === "export_touchpoints" ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                        <FileSpreadsheet className="h-3.5 w-3.5 mr-1" />
                    )}
                    Export Touchpoints
                </Button>
                <button
                    type="button"
                    onClick={onClear}
                    className="ml-1 text-brand-500 hover:text-brand-700"
                    aria-label="Clear selection"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

            <Modal
                open={mode !== null}
                onClose={() => setMode(null)}
                title={
                    mode === "reassign"
                        ? "Bulk Reassign"
                        : "Bulk Mark Lost"
                }
                subtitle={`${selectedIds.length} lead(s) selected`}
                width="sm"
                footer={
                    <>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setMode(null)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            onClick={submit}
                            disabled={busy}
                        >
                            {busy && (
                                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                            )}
                            Apply
                        </Button>
                    </>
                }
            >
                <div className="space-y-4">
                    {mode === "reassign" && (
                        <div>
                            <label className="block text-xs font-medium text-ink-muted mb-1">
                                Reassign to
                            </label>
                            <select
                                value={targetUserId}
                                onChange={(e) =>
                                    setTargetUserId(e.target.value)
                                }
                                className="w-full h-9 rounded-md border border-border px-2 text-sm"
                            >
                                <option value="">Select a rep or ASM…</option>
                                {users.map((u) => (
                                    <option key={u.user_id} value={u.user_id}>
                                        {u.name ?? u.email} ({u.role})
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}
                    {mode === "mark_lost" && (
                        <div>
                            <label className="block text-xs font-medium text-ink-muted mb-1">
                                Lost reason
                            </label>
                            <select
                                value={lostReason}
                                onChange={(e) => setLostReason(e.target.value)}
                                className="w-full h-9 rounded-md border border-border px-2 text-sm"
                            >
                                {LOST_REASON.filter(
                                    (r) => r !== "onboarding_dropout",
                                ).map((r) => (
                                    <option key={r} value={r}>
                                        {r.replace(/_/g, " ")}
                                    </option>
                                ))}
                            </select>
                            {highImpact && (
                                <p className="mt-1.5 text-[11px] text-danger">
                                    High-impact reason — applies to every
                                    selected lead. Already-terminal leads are
                                    skipped.
                                </p>
                            )}
                        </div>
                    )}
                    <div>
                        <label className="block text-xs font-medium text-ink-muted mb-1">
                            Reason <span className="text-ink-muted">(required)</span>
                        </label>
                        <textarea
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            rows={3}
                            placeholder="Recorded as a touchpoint on every affected lead."
                            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-100"
                        />
                    </div>
                </div>
            </Modal>
        </>
    );
}
