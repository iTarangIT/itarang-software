"use client";

// ID 179 (Kartik 15 Oct) — "Reassign to ISR" on the lead page for Admin, Sales
// Head and CEO (the Leads page's bulk-reassign roles, LEADS_BULK_ROLES). It
// posts to the SAME endpoint and rules as Leads › Reassign
// (/api/admin/leads/bulk, action "reassign"): a reason is required, a lead with
// a field visit booked stays with the ASM (the route answers why), the new
// owner gets a bell, and the rep it was taken from is told.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Modal } from "../Modal";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import type { UserOption } from "@/lib/admin/types";

/** Same minimum as the Leads page drawer's Reassign. */
const REASON_MIN = 5;

type Props = {
    open: boolean;
    onClose: () => void;
    leadId: string;
    currentOwnerId: string | null;
    onSuccess: () => void;
};

export function ReassignToIsrModal({ open, onClose, leadId, currentOwnerId, onSuccess }: Props) {
    const [targetId, setTargetId] = useState("");
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const usersQuery = useQuery<{ success: true; data: { users: UserOption[] } }>({
        queryKey: ["admin-user-options", "inside_sales_rep"],
        enabled: open,
        queryFn: async () => {
            const res = await fetch("/api/admin/users?roles=inside_sales_rep", { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load inside sales reps");
            return res.json();
        },
        staleTime: 5 * 60 * 1000,
    });
    const options = useMemo(
        () => (usersQuery.data?.data.users ?? []).filter((u) => u.user_id !== currentOwnerId),
        [usersQuery.data, currentOwnerId],
    );

    const submit = async () => {
        if (!targetId) {
            toast.error("Pick the inside sales rep to give the lead to.");
            return;
        }
        if (reason.trim().length < REASON_MIN) {
            toast.error(`Give a reason (at least ${REASON_MIN} characters).`);
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch("/api/admin/leads/bulk", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "reassign", lead_ids: [leadId], target_user_id: targetId, reason: reason.trim() }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Reassign failed");
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
            title="Reassign to ISR"
            width="md"
            closeOnBackdrop={!submitting}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={submit} disabled={submitting || !targetId || reason.trim().length < REASON_MIN}>
                        {submitting ? "Reassigning…" : "Reassign"}
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                <div>
                    <Label>Give the lead to</Label>
                    <select
                        value={targetId}
                        onChange={(e) => setTargetId(e.target.value)}
                        disabled={submitting || usersQuery.isLoading}
                        className="mt-1 h-9 w-full rounded-md border border-gray-200 bg-white px-2 text-sm"
                    >
                        <option value="">{usersQuery.isLoading ? "Loading reps…" : "Pick an inside sales rep"}</option>
                        {options.map((u) => (
                            <option key={u.user_id} value={u.user_id}>
                                {u.name ?? u.email}
                            </option>
                        ))}
                    </select>
                    {usersQuery.error && <p className="mt-1 text-[11px] text-rose-600">Could not load the reps.</p>}
                    <p className="mt-1 text-[11px] text-gray-500">
                        Same rules as Leads › Reassign. A lead with a field visit booked stays with the ASM.
                    </p>
                </div>
                <div>
                    <Label>
                        Reason <span className="text-rose-600">*</span>
                    </Label>
                    <textarea
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm min-h-[80px]"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Why is this lead being reassigned? The rep it is taken from will see this."
                        maxLength={2000}
                    />
                </div>
            </div>
        </Modal>
    );
}
