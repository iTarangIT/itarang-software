"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "../Modal";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type Props = {
    open: boolean;
    onClose: () => void;
    leadId: string;
    viewerId: string;
    onSuccess: () => void;
    /**
     * ID 155 / 221: who the lead can go to, by name — for the owner their
     * direct reports, for a manager themself + their team. Never a user id.
     */
    teamTargets?: TeamTarget[];
    /** ID 155: true when the viewer moves a team member's lead as their manager. */
    asManager?: boolean;
};

export type TeamTarget = { id: string; name: string; role: string; territory?: string | null; is_self: boolean };

export function ReassignLeadModal({ open, onClose, leadId, viewerId, onSuccess, teamTargets, asManager = false }: Props) {
    const teamMode = asManager;
    const targets = teamTargets ?? [];
    const [targetId, setTargetId] = useState("");
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!targetId.trim()) {
            toast.error("Pick who gets the lead.");
            return;
        }
        // ID 155: in team mode the manager may take the lead themself.
        if (!teamMode && targetId.trim() === viewerId) {
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
                    <Label>Move to</Label>
                    <select
                        value={targetId}
                        onChange={(e) => setTargetId(e.target.value)}
                        className="mt-1 h-9 w-full rounded-md border border-gray-200 bg-white px-2 text-sm"
                    >
                        <option value="">{teamMode ? "Pick yourself or a team member" : "Pick a team member"}</option>
                        {targets.map((t) => (
                            <option key={t.id} value={t.id}>
                                {t.is_self ? `Me (${t.name})` : t.name} · {t.role.replace(/_/g, " ")}
                                {t.territory ? ` · ${t.territory}` : ""}
                            </option>
                        ))}
                    </select>
                    <p className="text-[11px] text-gray-500 mt-1">
                        {teamMode
                            ? "As their manager you can move this lead to yourself or someone in your team."
                            : "You can hand this lead to someone in your team."}
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
            </form>
        </Modal>
    );
}
