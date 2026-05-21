"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "../Modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
    TOUCHPOINT_TYPE,
    CALL_STATUS,
    type TouchpointType,
    type CallStatus,
} from "@/lib/lifecycle/touchpointTypes";
import { LEAD_STATUS, type LeadStatus } from "@/lib/lifecycle/transitions";
import type { LeadDetailLead } from "@/lib/inside-sales/types";

type Props = {
    open: boolean;
    onClose: () => void;
    leadId: string;
    lead: LeadDetailLead;
    onSuccess: () => void;
    onStaleConflict: (info: { currentOwnerName?: string | null; currentUpdatedAt?: string | null }) => void;
    updatedAt: string | null;
};

const REP_TYPES: TouchpointType[] = [
    "inside_sales_call",
    "whatsapp",
    "status_change_note",
];

export function LogTouchpointModal({ open, onClose, leadId, lead, onSuccess, onStaleConflict, updatedAt }: Props) {
    const [type, setType] = useState<TouchpointType>("inside_sales_call");
    const [callStatus, setCallStatus] = useState<CallStatus | "">("");
    const [duration, setDuration] = useState("");
    const [remarks, setRemarks] = useState("");
    const [isEngaged, setIsEngaged] = useState(false);
    const [changeStatus, setChangeStatus] = useState(false);
    const [toStatus, setToStatus] = useState<LeadStatus | "">("");
    const [followUpAt, setFollowUpAt] = useState("");
    const [submitting, setSubmitting] = useState(false);

    // Every lead status except New_Unassigned — the initial, pre-assignment
    // state, which a lead can never transition back into. The server still
    // validates the chosen transition against the BRD §0.7 map on save.
    const statusTargets: LeadStatus[] = LEAD_STATUS.filter(
        (s) => s !== "New_Unassigned",
    );

    const reset = () => {
        setType("inside_sales_call");
        setCallStatus("");
        setDuration("");
        setRemarks("");
        setIsEngaged(false);
        setChangeStatus(false);
        setToStatus("");
        setFollowUpAt("");
        setSubmitting(false);
    };

    const handleClose = () => {
        if (submitting) return;
        reset();
        onClose();
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!remarks.trim()) {
            toast.error("Remarks are required.");
            return;
        }
        setSubmitting(true);
        try {
            const body: Record<string, unknown> = {
                touchpoint_type: type,
                remarks: remarks.trim(),
            };
            if (type === "inside_sales_call" && callStatus) body.call_status = callStatus;
            if (duration) body.call_duration_sec = Math.max(0, parseInt(duration, 10) || 0);
            if (isEngaged) body.is_engaged = true;
            if (changeStatus && toStatus) {
                body.status_change = { to: toStatus };
            }
            if (followUpAt) body.follow_up_at = new Date(followUpAt).toISOString();

            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/touchpoint`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(updatedAt ? { "X-Lead-Updated-At": updatedAt } : {}),
                },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            if (!res.ok) {
                if (res.status === 409 && json?.error?.code === "STALE_LEAD") {
                    onStaleConflict(json.error);
                    return;
                }
                throw new Error(json?.error?.message ?? "Failed to log touchpoint");
            }
            toast.success("Touchpoint logged.");
            reset();
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
            onClose={handleClose}
            title="Log Touchpoint"
            subtitle={lead.dealer_name ?? lead.shop_name ?? leadId}
            width="md"
            closeOnBackdrop={!submitting}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={handleClose} disabled={submitting}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={submit} disabled={submitting}>
                        {submitting ? "Saving…" : "Save touchpoint"}
                    </Button>
                </>
            }
        >
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <Label>Touchpoint type</Label>
                    <select
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm bg-white"
                        value={type}
                        onChange={(e) => setType(e.target.value as TouchpointType)}
                    >
                        {(REP_TYPES.length ? REP_TYPES : TOUCHPOINT_TYPE).map((t) => (
                            <option key={t} value={t}>{t.replaceAll("_", " ")}</option>
                        ))}
                    </select>
                </div>

                {type === "inside_sales_call" && (
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <Label>Call status</Label>
                            <select
                                className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm bg-white"
                                value={callStatus}
                                onChange={(e) => setCallStatus(e.target.value as CallStatus | "")}
                            >
                                <option value="">— select —</option>
                                {CALL_STATUS.map((c) => (
                                    <option key={c} value={c}>{c.replaceAll("_", " ")}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <Label>Duration (sec)</Label>
                            <Input
                                type="number"
                                min={0}
                                value={duration}
                                onChange={(e) => setDuration(e.target.value)}
                                className="mt-1"
                            />
                        </div>
                    </div>
                )}

                <div>
                    <Label>Remarks <span className="text-rose-600">*</span></Label>
                    <textarea
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm min-h-[88px]"
                        value={remarks}
                        onChange={(e) => setRemarks(e.target.value)}
                        placeholder="What happened in this interaction?"
                    />
                </div>

                <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                        type="checkbox"
                        checked={isEngaged}
                        onChange={(e) => setIsEngaged(e.target.checked)}
                    />
                    Mark as engaged touchpoint
                    <span className="text-[11px] text-gray-500">(qualifies a lead to advance from Assigned_Not_Contacted → Under_Discussion)</span>
                </label>

                <label className="flex items-center gap-2 text-sm text-gray-700 pt-1">
                    <input
                        type="checkbox"
                        checked={changeStatus}
                        onChange={(e) => setChangeStatus(e.target.checked)}
                    />
                    Update lead status with this touchpoint
                </label>
                {changeStatus && (
                    <div>
                        <Label>New status</Label>
                        <select
                            className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm bg-white"
                            value={toStatus}
                            onChange={(e) => setToStatus(e.target.value as LeadStatus | "")}
                        >
                            <option value="">— select —</option>
                            {statusTargets.map((s) => (
                                <option key={s} value={s}>{s}</option>
                            ))}
                        </select>
                        <p className="text-[11px] text-gray-500 mt-1">
                            Server validates against the transition map (BRD §0.7). Invalid transitions return an error.
                        </p>
                    </div>
                )}

                <div>
                    <Label>Set next follow-up (optional)</Label>
                    <Input
                        type="datetime-local"
                        value={followUpAt}
                        onChange={(e) => setFollowUpAt(e.target.value)}
                        className="mt-1"
                    />
                </div>
            </form>
        </Modal>
    );
}
