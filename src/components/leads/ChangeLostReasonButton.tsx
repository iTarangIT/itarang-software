"use client";

// "Change Lost reason" for a Lost lead (tracker ID 136) — the Sales Head and
// admin fix a wrong reason; the lead stays Lost with its closed date and
// closing owner. POST /api/admin/leads/[id]/lost-reason. A Lost that should not
// be Lost at all is Reactivate, not this.
//
// Render it only for the Sales Head / admin (caps.canChangeLostReason) and only
// on a Lost lead; the endpoint refuses anything else.

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CHANGEABLE_LOST_REASONS } from "@/lib/leads/changeLostReasonRules";
import { LOST_REASON_LABELS } from "@/app/(dashboard)/inside-sales/_components/modals/MarkLostModal";
import type { LostReason } from "@/lib/lifecycle/transitions";

export function ChangeLostReasonButton({
    leadId,
    currentReason,
    onDone,
    compact = false,
}: {
    leadId: string;
    currentReason: string | null;
    onDone?: () => void;
    /** Header placement: a small button that opens the form below it. */
    compact?: boolean;
}) {
    const [open, setOpen] = useState(!compact);
    const [reason, setReason] = useState<LostReason | "">("");
    const [competitor, setCompetitor] = useState("");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const ready =
        !!reason && note.trim().length >= 5 && (reason !== "lost_to_competition" || !!competitor.trim());

    async function submit() {
        if (!ready) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/admin/leads/${encodeURIComponent(leadId)}/lost-reason`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    lost_reason: reason,
                    note: note.trim(),
                    competitor_name: reason === "lost_to_competition" ? competitor.trim() : undefined,
                }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || json?.success === false) throw new Error(json?.error?.message ?? "Could not change the reason");
            toast.success("Lost reason changed.");
            setReason("");
            setCompetitor("");
            setNote("");
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
                className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
                <Tag className="h-3 w-3" />
                Change Lost reason
            </button>
        );
    }

    const current = currentReason ? LOST_REASON_LABELS[currentReason as LostReason] ?? currentReason.replace(/_/g, " ") : "none";

    return (
        <div className={`rounded-lg border border-gray-200 bg-gray-50 p-3 ${compact ? "basis-full max-w-lg" : ""}`}>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <Tag className="h-3.5 w-3.5 text-gray-500" />
                Change Lost reason
            </h3>
            <p className="mt-1 text-[11px] text-gray-600">
                Now: <span className="font-medium">{current}</span>. The lead stays Lost — closed date and closing
                owner do not change. The old and new reason go in its history.
            </p>
            <div className="mt-2 space-y-2">
                <select
                    value={reason}
                    onChange={(e) => setReason(e.target.value as LostReason | "")}
                    disabled={busy}
                    className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm"
                >
                    <option value="">New Lost reason…</option>
                    {CHANGEABLE_LOST_REASONS.map((r) => (
                        <option key={r} value={r}>
                            {LOST_REASON_LABELS[r]}
                        </option>
                    ))}
                </select>
                {reason === "lost_to_competition" && (
                    <input
                        value={competitor}
                        onChange={(e) => setCompetitor(e.target.value)}
                        placeholder="Competitor (required)"
                        disabled={busy}
                        className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm"
                    />
                )}
                <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={3}
                    placeholder="Why is the reason changing? (required)"
                    disabled={busy}
                    className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-100 disabled:bg-gray-50"
                />
            </div>
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
                <Button type="button" size="sm" onClick={submit} disabled={busy || !ready}>
                    {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    Save reason
                </Button>
            </div>
        </div>
    );
}
