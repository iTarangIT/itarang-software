"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "../Modal";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { HighImpactConfirmDialog } from "../HighImpactConfirmDialog";
import { LOST_REASON, isHighImpactLostReason, type LostReason } from "@/lib/lifecycle/transitions";

type Props = {
    open: boolean;
    onClose: () => void;
    leadId: string;
    onSuccess: () => void;
};

const LABELS: Record<LostReason, string> = {
    not_interested: "Not interested",
    price_high: "Price too high",
    bad_experience_with_trontek: "Bad experience with Trontek",
    loan_procedure_issue: "Loan procedure issue",
    business_closed: "Business closed",
    non_operational_location: "Non-operational location",
    rejected_by_us_credit: "Rejected by us — credit",
    rejected_by_us_geography: "Rejected by us — geography",
    duplicate_lead: "Duplicate lead",
    other: "Other (notes required)",
    onboarding_dropout: "Onboarding dropout (admin only)",
};

export function MarkLostModal({ open, onClose, leadId, onSuccess }: Props) {
    const [reason, setReason] = useState<LostReason | "">("");
    const [notes, setNotes] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [confirmingHighImpact, setConfirmingHighImpact] = useState(false);

    const handleClose = () => {
        if (submitting) return;
        setReason("");
        setNotes("");
        setConfirmingHighImpact(false);
        onClose();
    };

    const submit = async (confirmedHighImpact = false) => {
        if (!reason) {
            toast.error("Pick a Lost reason.");
            return;
        }
        if (reason === "other" && !notes.trim()) {
            toast.error("Notes are required when reason is 'other'.");
            return;
        }
        if (reason === "onboarding_dropout") {
            toast.error("onboarding_dropout is admin-only (BRD §0.11).");
            return;
        }
        if (isHighImpactLostReason(reason) && !confirmedHighImpact) {
            setConfirmingHighImpact(true);
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/mark-lost`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    lost_reason: reason,
                    lost_reason_notes: notes.trim() || null,
                    confirmed_high_impact: confirmedHighImpact || undefined,
                }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to mark lost");
            toast.success("Lead marked Lost.");
            handleClose();
            onSuccess();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <>
            <Modal
                open={open && !confirmingHighImpact}
                onClose={handleClose}
                title="Mark Lost"
                width="sm"
                closeOnBackdrop={!submitting}
                footer={
                    <>
                        <Button type="button" variant="outline" onClick={handleClose} disabled={submitting}>Cancel</Button>
                        <Button
                            type="button"
                            onClick={() => submit(false)}
                            disabled={submitting}
                            className="bg-rose-600 hover:bg-rose-700 text-white"
                        >
                            {submitting ? "Saving…" : "Mark Lost"}
                        </Button>
                    </>
                }
            >
                <div className="space-y-4">
                    <div>
                        <Label>Lost reason <span className="text-rose-600">*</span></Label>
                        <select
                            className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm bg-white"
                            value={reason}
                            onChange={(e) => setReason(e.target.value as LostReason | "")}
                        >
                            <option value="">— select —</option>
                            {LOST_REASON.filter((r) => r !== "onboarding_dropout").map((r) => (
                                <option key={r} value={r}>{LABELS[r]}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <Label>Notes {reason === "other" && <span className="text-rose-600">*</span>}</Label>
                        <textarea
                            className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm min-h-[64px]"
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                        />
                    </div>
                </div>
            </Modal>
            <HighImpactConfirmDialog
                open={confirmingHighImpact}
                reason={reason || null}
                loading={submitting}
                onCancel={() => setConfirmingHighImpact(false)}
                onConfirm={() => submit(true)}
            />
        </>
    );
}
