"use client";

// "Reactivate" for a Lost lead (BRD §0.9) — the one manual entry point to the
// unified reactivation procedure (src/lib/leads/reactivation.ts) via
// POST /api/admin/leads/bulk { action: "reactivate" }. Unlike "Correct status",
// it routes the lead back to its originator (or the unassigned pool), keeps the
// old reason as previous_lost_reason, marks it sales-ready so it shows in Ready
// to Assign, and lifts a "business closed" AI-recall exclusion.
//
// Render it only for LEADS_BULK_ROLES (the endpoint's own gate) and only on a
// Lost lead; the endpoint skips anything else.

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

type Reactivated = { id: string; new_status: string; new_owner_id: string | null };

export function ReactivateLeadButton({
    leadId,
    onDone,
    compact = false,
}: {
    leadId: string;
    onDone?: () => void;
    /** Header placement: a small button that opens the form below it. */
    compact?: boolean;
}) {
    const [open, setOpen] = useState(!compact);
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit() {
        if (reason.trim().length < 5) {
            setError("Reason must be at least 5 characters.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const res = await fetch("/api/admin/leads/bulk", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "reactivate", lead_ids: [leadId], reason: reason.trim() }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Reactivation failed");
            const r = (json.data?.reactivated as Reactivated[] | undefined)?.[0];
            if (!r) throw new Error("This lead is no longer Lost — refresh to see its current status.");
            toast.success(
                r.new_owner_id
                    ? "Lead reactivated and handed back to the person who brought it in."
                    : "Lead reactivated. It is unassigned and waiting in Ready to Assign.",
            );
            setReason("");
            if (compact) setOpen(false);
            onDone?.();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    if (!open) {
        return (
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
            >
                <RotateCcw className="h-3 w-3" />
                Reactivate
            </button>
        );
    }

    return (
        // In the lead-page header row the open form takes a line of its own.
        <div className={`rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 ${compact ? "basis-full max-w-lg" : ""}`}>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <RotateCcw className="h-3.5 w-3.5 text-emerald-700" />
                Reactivate this Lost lead
            </h3>
            <p className="mt-1 text-[11px] text-gray-600">
                It goes back to the person who brought it in (if still active), otherwise to Ready to
                Assign. The Lost reason is kept in its history.
            </p>
            <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Why is this lead being reactivated? (e.g. dealer called back, number corrected)"
                disabled={busy}
                className="mt-2 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-100 disabled:bg-gray-50"
            />
            {error && (
                <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
                    {error}
                </div>
            )}
            <div className="mt-2 flex items-center justify-end gap-2">
                {compact && (
                    <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>
                        Cancel
                    </Button>
                )}
                <Button type="button" size="sm" onClick={submit} disabled={busy || reason.trim().length < 5}>
                    {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    Reactivate
                </Button>
            </div>
        </div>
    );
}
