"use client";

// BRD §0.4 — resolve a merge request. Address-mismatch requests get 5 actions;
// phone-collision requests get 3. admin_resolution_notes is always required.

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Modal } from "@/app/(dashboard)/inside-sales/_components/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    ADDRESS_MISMATCH_ACTIONS,
    MERGE_ACTION_LABELS,
    PHONE_COLLISION_ACTIONS,
    type MergeRequestRow,
} from "@/lib/admin/types";

type Props = {
    open: boolean;
    request: MergeRequestRow;
    onClose: () => void;
    onSuccess: () => void;
};

export function ResolveMergeRequestModal({
    open,
    request,
    onClose,
    onSuccess,
}: Props) {
    const isAddress = request.request_type.startsWith("address_mismatch");
    const actions: readonly string[] = isAddress
        ? ADDRESS_MISMATCH_ACTIONS
        : PHONE_COLLISION_ACTIONS;

    const [action, setAction] = useState<string>(actions[0]);
    const [notes, setNotes] = useState("");
    const [newAddress, setNewAddress] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const canSubmit = notes.trim().length >= 5 && !submitting;

    async function submit() {
        setSubmitting(true);
        try {
            const res = await fetch(
                `/api/admin/merge-requests/${request.id}/resolve`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        resolution_action: action,
                        admin_resolution_notes: notes.trim(),
                        new_address:
                            action === "same_dealer_relocated"
                                ? newAddress.trim() || null
                                : null,
                    }),
                },
            );
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Failed to resolve");
            }
            toast.success("Merge request resolved.");
            onSuccess();
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            title="Resolve Merge Request"
            subtitle={request.target_dealer_name ?? request.target_lead_id}
            width="md"
            footer={
                <>
                    <Button type="button" variant="outline" size="sm" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        onClick={submit}
                        disabled={!canSubmit}
                    >
                        {submitting && (
                            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                        )}
                        Resolve
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                {request.request_notes && (
                    <div className="rounded-md bg-bg border border-border p-3 text-xs text-ink-muted">
                        {request.request_notes}
                    </div>
                )}

                <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">
                        Resolution action
                    </label>
                    <select
                        value={action}
                        onChange={(e) => setAction(e.target.value)}
                        className="w-full h-9 rounded-md border border-border px-2 text-sm"
                    >
                        {actions.map((a) => (
                            <option key={a} value={a}>
                                {MERGE_ACTION_LABELS[a] ?? a}
                            </option>
                        ))}
                    </select>
                </div>

                {action === "same_dealer_relocated" && (
                    <div>
                        <label className="block text-xs font-medium text-ink-muted mb-1">
                            New address{" "}
                            <span className="text-ink-muted">
                                (optional — leave blank to keep current)
                            </span>
                        </label>
                        <Input
                            value={newAddress}
                            onChange={(e) => setNewAddress(e.target.value)}
                            placeholder="Updated dealer address"
                            className="h-9"
                        />
                        <p className="mt-1 text-[11px] text-ink-muted">
                            The current address is appended to the lead&apos;s
                            address history.
                        </p>
                    </div>
                )}

                <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">
                        Resolution notes{" "}
                        <span className="text-ink-muted">(required)</span>
                    </label>
                    <textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        rows={3}
                        placeholder="Why this decision — recorded on the merge request."
                        className="w-full rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-100"
                    />
                </div>
            </div>
        </Modal>
    );
}
