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
    viewerId: string;
    onSuccess: () => void;
};

export function ReassignLeadModal({ open, onClose, leadId, viewerId, onSuccess }: Props) {
    const [targetId, setTargetId] = useState("");
    const [reason, setReason] = useState("");
    const [notifyAdmin, setNotifyAdmin] = useState(true);
    const [submitting, setSubmitting] = useState(false);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!targetId.trim()) {
            toast.error("Target user id required.");
            return;
        }
        if (targetId.trim() === viewerId) {
            toast.error("Cannot reassign to yourself.");
            return;
        }
        if (reason.trim().length < 20) {
            toast.error("Reason must be at least 20 characters (BRD §0.3).");
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/reassign`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    target_user_id: targetId.trim(),
                    reason: reason.trim(),
                    notify_admin: notifyAdmin,
                }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to reassign");
            toast.success("Lead reassigned.");
            setTargetId("");
            setReason("");
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
            title="Reassign Lead"
            width="md"
            closeOnBackdrop={!submitting}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
                    <Button type="button" onClick={submit} disabled={submitting}>
                        {submitting ? "Reassigning…" : "Reassign"}
                    </Button>
                </>
            }
        >
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <Label>Target user id (UUID)</Label>
                    <Input
                        value={targetId}
                        onChange={(e) => setTargetId(e.target.value)}
                        placeholder="e.g. 42d4131a-560b-4266-a2de-6acb40393ed5"
                        className="mt-1 font-mono text-xs"
                    />
                    <p className="text-[11px] text-gray-500 mt-1">
                        Module 3 will replace this with a typeahead. For now, paste the target user&apos;s UUID.
                    </p>
                </div>
                <div>
                    <Label>Reason <span className="text-rose-600">*</span> <span className="text-[11px] text-gray-500">(min 20 chars)</span></Label>
                    <textarea
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm min-h-[80px]"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                    />
                    <div className="text-[11px] text-gray-500 mt-1">{reason.trim().length} / 20+ chars</div>
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                        type="checkbox"
                        checked={notifyAdmin}
                        onChange={(e) => setNotifyAdmin(e.target.checked)}
                    />
                    Notify admin
                </label>
            </form>
        </Modal>
    );
}
