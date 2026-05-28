"use client";

import { useState } from "react";
import { toast } from "sonner";
import { UserPlus2 } from "lucide-react";
import { Modal } from "../Modal";
import { Button } from "@/components/ui/button";

type Props = {
    open: boolean;
    onClose: () => void;
    leadId: string;
    dealerName: string;
    onSuccess: () => void;
};

export function ClaimLeadConfirm({ open, onClose, leadId, dealerName, onSuccess }: Props) {
    const [submitting, setSubmitting] = useState(false);

    const submit = async () => {
        setSubmitting(true);
        try {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/claim`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to claim lead");
            toast.success("Lead claimed. You are now the owner.");
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
            title="Claim Lead"
            width="sm"
            closeOnBackdrop={!submitting}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
                    <Button type="button" onClick={submit} disabled={submitting}>
                        {submitting ? "Claiming…" : "Claim lead"}
                    </Button>
                </>
            }
        >
            <div className="flex items-start gap-3">
                <div className="shrink-0 h-10 w-10 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
                    <UserPlus2 className="h-5 w-5" />
                </div>
                <div className="space-y-2 text-sm text-gray-700">
                    <p>You will become the current owner of <span className="font-semibold text-gray-900">{dealerName}</span>.</p>
                    <p className="text-xs text-gray-500">
                        Status will move from <code>New_Unassigned</code> to <code>Assigned_Not_Contacted</code>. You can reassign later from the action bar if needed.
                    </p>
                </div>
            </div>
        </Modal>
    );
}
