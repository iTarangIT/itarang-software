"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "../Modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type Props = {
    open: boolean;
    onClose: () => void;
    leadId: string;
    viewerRole: string;
    onSuccess: () => void;
};

const IS_REP_REASONS = [
    "Commercial_Decision_Needed",
    "Customer_Complaint",
    "Compliance_Concern",
    "Internal_Dispute",
    "Other",
];

const ASM_REASONS = [
    "Not_Ready_for_Visit",
    "Dealer_Stalling",
    "Territory_Mismatch",
    "Customer_Complaint",
    "Internal_Dispute",
    "Compliance_Concern",
    "Other",
];

export function EscalateModal({ open, onClose, leadId, viewerRole, onSuccess }: Props) {
    const reasons = viewerRole === "asm" ? ASM_REASONS : IS_REP_REASONS;
    const [reason, setReason] = useState(reasons[0]);
    const [notes, setNotes] = useState("");
    const [suggestedAction, setSuggestedAction] = useState("");
    const [urgency, setUrgency] = useState<"normal" | "high" | "urgent">("normal");
    const [submitting, setSubmitting] = useState(false);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (notes.trim().length < 30) {
            toast.error("Escalation notes must be at least 30 characters (BRD §0.6).");
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/escalate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    escalation_reason: reason,
                    escalation_notes: notes.trim(),
                    suggested_action: suggestedAction.trim() || null,
                    urgency,
                }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to escalate");
            toast.success("Escalation raised. Admin will review.");
            setNotes("");
            setSuggestedAction("");
            onSuccess();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            open={open}
            onClose={() => !submitting && onClose()}
            title="Escalate"
            subtitle="Flag for admin review — owner stays unchanged"
            width="md"
            closeOnBackdrop={!submitting}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
                    <Button
                        type="button"
                        onClick={submit}
                        disabled={submitting}
                        className="bg-amber-600 hover:bg-amber-700 text-white"
                    >
                        {submitting ? "Raising…" : "Raise escalation"}
                    </Button>
                </>
            }
        >
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <Label>Reason</Label>
                    <select
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm bg-white"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                    >
                        {reasons.map((r) => <option key={r} value={r}>{r.replaceAll("_", " ")}</option>)}
                    </select>
                </div>
                <div>
                    <Label>Urgency</Label>
                    <div className="mt-1 flex gap-2">
                        {(["normal", "high", "urgent"] as const).map((u) => (
                            <button
                                type="button"
                                key={u}
                                onClick={() => setUrgency(u)}
                                className={`flex-1 rounded-md border px-3 py-2 text-xs font-semibold transition ${
                                    urgency === u
                                        ? u === "urgent"
                                            ? "border-rose-300 bg-rose-50 text-rose-700"
                                            : u === "high"
                                                ? "border-amber-300 bg-amber-50 text-amber-700"
                                                : "border-blue-300 bg-blue-50 text-blue-700"
                                        : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                                }`}
                            >
                                {u.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>
                <div>
                    <Label>What&apos;s happening / what do you need? <span className="text-rose-600">*</span> <span className="text-[11px] text-gray-500">(min 30 chars)</span></Label>
                    <textarea
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm min-h-[100px]"
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                    />
                    <div className="text-[11px] text-gray-500 mt-1">{notes.trim().length} / 30+ chars</div>
                </div>
                <div>
                    <Label>Suggested action (optional)</Label>
                    <Input
                        value={suggestedAction}
                        onChange={(e) => setSuggestedAction(e.target.value)}
                        placeholder="e.g. Reassign to senior rep; close as Lost"
                        className="mt-1"
                    />
                </div>
            </form>
        </Modal>
    );
}
