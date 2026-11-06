"use client";

// Reassign a lead, by name. ID 221 (decided 3 Nov, Kartik): nobody pastes a
// user id. The owner picks from their own team (active direct reports); a
// manager moving a team member's lead (ID 155) picks themself or someone in the
// team. The list comes from GET /api/inside-sales/lead/[id]/reassign, and the
// server refuses anyone else. The old "Notify admin" tick told nobody: the
// old owner's manager now gets a bell with the reason.

import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "../Modal";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export type TeamTarget = { id: string; name: string; role: string; territory?: string; is_self: boolean };

type Props = {
    open: boolean;
    onClose: () => void;
    leadId: string;
    onSuccess: () => void;
    /** The people this lead may go to (from the GET above). */
    targets: TeamTarget[];
    /** True when the viewer is the owner's manager, not the owner. */
    asManager?: boolean;
};

const REASON_MIN = 20;

export function ReassignLeadModal({ open, onClose, leadId, onSuccess, targets, asManager = false }: Props) {
    const [targetId, setTargetId] = useState("");
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!targetId) {
            toast.error("Pick who gets the lead.");
            return;
        }
        if (reason.trim().length < REASON_MIN) {
            toast.error(`Give a reason of at least ${REASON_MIN} characters.`);
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/reassign`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ target_user_id: targetId, reason: reason.trim() }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to reassign");
            const moved = Number(json?.data?.visits_moved ?? 0);
            toast.success(moved > 0 ? `Lead reassigned; ${moved} booked visit${moved === 1 ? "" : "s"} moved with it.` : "Lead reassigned.");
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
                    <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={submit} disabled={submitting || targets.length === 0}>
                        {submitting ? "Reassigning…" : "Reassign"}
                    </Button>
                </>
            }
        >
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <Label>Give to</Label>
                    <select
                        value={targetId}
                        onChange={(e) => setTargetId(e.target.value)}
                        className="mt-1 h-9 w-full rounded-md border border-gray-200 bg-white px-2 text-sm"
                    >
                        <option value="">{asManager ? "Pick yourself or a team member" : "Pick someone in your team"}</option>
                        {targets.map((t) => (
                            <option key={t.id} value={t.id}>
                                {t.is_self ? `Me (${t.name})` : t.name} · {t.role.replace(/_/g, " ")}
                                {t.territory && t.territory !== "—" ? ` · ${t.territory}` : ""}
                            </option>
                        ))}
                    </select>
                    <p className="text-[11px] text-gray-500 mt-1">
                        {asManager
                            ? "As their manager you can move this lead to yourself or someone in your team."
                            : "Only the people in your team are listed. To give a lead to anyone else, ask your manager or the Sales Head."}
                    </p>
                </div>
                <div>
                    <Label>
                        Reason <span className="text-rose-600">*</span>{" "}
                        <span className="text-[11px] text-gray-500">(min {REASON_MIN} chars)</span>
                    </Label>
                    <textarea
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm min-h-[80px]"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                    />
                    <div className="text-[11px] text-gray-500 mt-1">
                        {reason.trim().length} / {REASON_MIN}+ chars · the new owner and the current owner&apos;s manager are told, with this reason.
                    </div>
                </div>
            </form>
        </Modal>
    );
}
