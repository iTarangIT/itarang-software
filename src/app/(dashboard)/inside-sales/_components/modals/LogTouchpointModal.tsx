"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "../Modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { type TouchpointType } from "@/lib/lifecycle/touchpointTypes";
import {
    DispositionPicker,
    EMPTY_DISPOSITION_VALUE,
    type DispositionValue,
} from "@/components/leads/DispositionPicker";
import { LEAD_STATUS, type LeadStatus } from "@/lib/lifecycle/transitions";
import type { LeadDetailLead } from "@/lib/inside-sales/types";
import {
    useVisitForm,
    VisitFields,
} from "@/app/(dashboard)/asm/_components/VisitFields";
import type { VisitNextAction } from "@/lib/asm/types";

type Props = {
    open: boolean;
    onClose: () => void;
    leadId: string;
    lead: LeadDetailLead;
    onSuccess: () => void;
    onStaleConflict: (info: { currentOwnerName?: string | null; currentUpdatedAt?: string | null }) => void;
    updatedAt: string | null;
    /**
     * "asm" unlocks the "visit" touchpoint type, which swaps the body for the
     * full visit form and saves a real lead_visits row. Defaults to
     * "inside_sales" so the inside-sales lead detail is unchanged.
     */
    context?: "inside_sales" | "asm";
    /** Called after a "visit"-type save so the caller can chain into the
     *  Convert / Lost / Escalate modal (same contract as LogVisitModal). */
    onVisitSuccess?: (result: { next_action: VisitNextAction }) => void;
};

const REP_TYPES: TouchpointType[] = [
    "inside_sales_call",
    "whatsapp",
    "status_change_note",
];

export function LogTouchpointModal({
    open,
    onClose,
    leadId,
    lead,
    onSuccess,
    onStaleConflict,
    updatedAt,
    context = "inside_sales",
    onVisitSuccess,
}: Props) {
    const [type, setType] = useState<TouchpointType>("inside_sales_call");
    // The rep now picks the CC team's L1/L2/L3 disposition; call_status is
    // derived from it server-side by the shared sheet-derived table, so the two
    // can never disagree. Optional in v1 — it starts blank exactly as the old
    // "— select —" call-status dropdown did, and adoption is measurable as
    // COUNT(*) WHERE last_disposition_source = 'inside_sales'.
    const [disposition, setDisposition] = useState<DispositionValue>(
        EMPTY_DISPOSITION_VALUE,
    );
    const [duration, setDuration] = useState("");
    const [remarks, setRemarks] = useState("");
    const [isEngaged, setIsEngaged] = useState(false);
    const [changeStatus, setChangeStatus] = useState(false);
    const [toStatus, setToStatus] = useState<LeadStatus | "">("");
    const [followUpAt, setFollowUpAt] = useState("");
    const [submitting, setSubmitting] = useState(false);

    // ASM-only "visit" branch — owns the visit form state independently.
    const visitForm = useVisitForm(open);
    const isVisit = type === "visit";

    const typeOptions: TouchpointType[] =
        context === "asm" ? [...REP_TYPES, "visit"] : REP_TYPES;

    // Every lead status except New_Unassigned — the pre-assignment state,
    // which would strand an owned lead outside every queue. Any of these can
    // be picked from any current status: the server no longer validates the
    // transition.
    const statusTargets: LeadStatus[] = LEAD_STATUS.filter(
        (s) => s !== "New_Unassigned",
    );

    const reset = () => {
        setType("inside_sales_call");
        setDisposition(EMPTY_DISPOSITION_VALUE);
        setDuration("");
        setRemarks("");
        setIsEngaged(false);
        setChangeStatus(false);
        setToStatus("");
        setFollowUpAt("");
        setSubmitting(false);
    };

    const busy = submitting || visitForm.submitting;

    const handleClose = () => {
        if (busy) return;
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
            if (type === "inside_sales_call" && disposition.disposition) {
                // The bucket is sent EXPLICITLY. "Commercials Explained" sits in
                // both Warm and Hot, and first-occurrence-wins would store Warm
                // for a rep who deliberately chose Hot — a loss the webhook has
                // to accept (no user to ask) but this form does not.
                body.disposition = {
                    connect_status: disposition.connectStatus,
                    bucket: disposition.bucket || null,
                    label: disposition.disposition,
                };
            }
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

    // Visit-type save posts a real lead_visits row via the visit API.
    const handleVisitSave = async () => {
        const result = await visitForm.submit(leadId);
        if (result) {
            reset();
            onVisitSuccess?.(result);
        }
    };

    return (
        <Modal
            open={open}
            onClose={handleClose}
            title="Log Touchpoint"
            subtitle={lead.dealer_name ?? lead.shop_name ?? leadId}
            width={isVisit ? "lg" : "md"}
            closeOnBackdrop={!busy}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={handleClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        onClick={(e) => {
                            if (isVisit) void handleVisitSave();
                            else void submit(e);
                        }}
                        disabled={busy}
                    >
                        {busy
                            ? "Saving…"
                            : isVisit
                                ? "Save visit"
                                : "Save touchpoint"}
                    </Button>
                </>
            }
        >
            <form
                onSubmit={(e) => {
                    if (isVisit) {
                        e.preventDefault();
                        void handleVisitSave();
                    } else {
                        void submit(e);
                    }
                }}
                className="space-y-4"
            >
                <div>
                    <Label>Touchpoint type</Label>
                    <select
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm bg-white"
                        value={type}
                        onChange={(e) => setType(e.target.value as TouchpointType)}
                    >
                        {typeOptions.map((t) => (
                            <option key={t} value={t}>{t.replaceAll("_", " ")}</option>
                        ))}
                    </select>
                </div>

                {isVisit ? (
                    <VisitFields form={visitForm} />
                ) : (
                    <>
                        {type === "inside_sales_call" && (
                            <div className="grid grid-cols-2 gap-3">
                                <div className="col-span-2">
                                    <Label>What happened on the call</Label>
                                    <div className="mt-1">
                                        <DispositionPicker
                                            mode="form"
                                            idPrefix="log-touchpoint"
                                            value={disposition}
                                            onChange={setDisposition}
                                        />
                                    </div>
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
                                    Any status can be set from any other — no transition restrictions.
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
                    </>
                )}
            </form>
        </Modal>
    );
}
