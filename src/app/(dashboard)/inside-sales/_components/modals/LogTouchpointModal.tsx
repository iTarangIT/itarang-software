"use client";

import { useEffect, useState } from "react";
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
import type { LeadStatus, LostReason } from "@/lib/lifecycle/transitions";
import type { LeadDetailLead } from "@/lib/inside-sales/types";
import {
    useVisitForm,
    VisitFields,
} from "@/app/(dashboard)/asm/_components/VisitFields";
import type { VisitNextAction } from "@/lib/asm/types";
import {
    autoProgressForCall,
    bucketForLabel,
    COMMERCIALS_CALL_LABELS,
    lostReasonForLabel,
    type Interest,
} from "@/lib/leads/autoProgress";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import { DISPOSITION_BUCKETS, type DispositionBucket } from "@/lib/leads/dispositions";

const INTERESTS: Interest[] = ["hot", "warm", "cold"];

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
    /** ID 76: a Lost-type call outcome was saved — open Mark Lost with this reason. */
    onLostOutcome?: (reason: LostReason | null) => void;
    /** ID 75: whether the lead has a live quote — a commercials outcome without one is flagged. */
    hasQuote?: boolean;
};

// ID 80 (29 Sep 2026): no "Status change" entry — every status change has an
// event behind it (calls, quotes, visits, approvals). Admin "Correct status"
// is the only override.
const REP_TYPES: TouchpointType[] = [
    "inside_sales_call",
    "whatsapp",
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
    onLostOutcome,
    hasQuote = false,
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
    // ID 79: a WhatsApp chat counts as contact only with a screenshot.
    const [waScreenshot, setWaScreenshot] = useState<File | null>(null);
    const [waReplied, setWaReplied] = useState(false);
    const [isEngaged, setIsEngaged] = useState(false);
    const [changeStatus, setChangeStatus] = useState(false);
    const [toStatus, setToStatus] = useState<LeadStatus | "">("");
    const [followUpAt, setFollowUpAt] = useState("");
    const [submitting, setSubmitting] = useState(false);
    // Temperature change to save with this touchpoint ("" = leave as is).
    const [toInterest, setToInterest] = useState<Interest | "">("");
    // Which of status / temperature were filled by the shared auto rule and
    // not touched by the rep since — the rep's own choice always wins.
    const [auto, setAuto] = useState({ status: false, interest: false });
    const [touched, setTouched] = useState({ status: false, interest: false });

    // Pre-fill status + temperature from the call outcome with the SAME rule
    // the WhatsApp Assistant proposes with (lib/leads/autoProgress.ts).
    useEffect(() => {
        if (type !== "inside_sales_call" || !disposition.disposition) return;
        const derived = autoProgressForCall({
            connected: disposition.connectStatus === "connected",
            label: disposition.disposition,
            bucket: (DISPOSITION_BUCKETS as readonly string[]).includes(disposition.bucket)
                ? (disposition.bucket as DispositionBucket)
                : null,
            currentStatus: lead.lead_status,
            currentInterest: lead.interest_level,
        });
        if (!touched.status) {
            setChangeStatus(!!derived.statusTo);
            setToStatus(derived.statusTo ?? "");
        }
        if (!touched.interest) setToInterest(derived.interestTo ?? "");
        setAuto({
            status: !touched.status && !!derived.statusTo,
            interest: !touched.interest && !!derived.interestTo,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- re-derive only when the outcome changes
    }, [type, disposition.disposition, disposition.connectStatus, disposition.bucket]);

    // ASM-only "visit" branch — owns the visit form state independently.
    const visitForm = useVisitForm(open, lead);
    const isVisit = type === "visit";

    const typeOptions: TouchpointType[] =
        context === "asm" ? [...REP_TYPES, "visit"] : REP_TYPES;


    const reset = () => {
        setType("inside_sales_call");
        setDisposition(EMPTY_DISPOSITION_VALUE);
        setDuration("");
        setRemarks("");
        setWaScreenshot(null);
        setWaReplied(false);
        setIsEngaged(false);
        setChangeStatus(false);
        setToStatus("");
        setFollowUpAt("");
        setToInterest("");
        setAuto({ status: false, interest: false });
        setTouched({ status: false, interest: false });
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
            if (type === "whatsapp") {
                const fd = new FormData();
                fd.append("remarks", remarks.trim());
                fd.append("dealer_replied", waReplied ? "true" : "false");
                if (waScreenshot) fd.append("screenshot", waScreenshot);
                const wr = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/whatsapp-contact`, {
                    method: "POST",
                    body: fd,
                });
                const wj = await wr.json();
                if (!wr.ok) throw new Error(wj?.error?.message ?? "Failed to log WhatsApp contact");
                if (wj?.data?.reused) toast.warning("That screenshot was already used — saved as a note, not counted.");
                else if (wj?.data?.countedAsContact) toast.success("WhatsApp contact logged.");
                else toast.success("Saved as a note (a reply needs a screenshot to count).");
                reset();
                onSuccess();
                return;
            }
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
            // ID 80 / 114: no manual status — the server applies the outcome
            // rule (autoProgress) in the status writer itself.
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
            // Temperature is its own audited write (interest_level_overrides).
            // The touchpoint already saved, so a failure here is reported, not rolled back.
            if (toInterest && toInterest !== lead.interest_level) {
                const ir = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/interest-level`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        interest_level: toInterest,
                        reason: auto.interest ? "Auto: from call outcome" : "Set with touchpoint",
                    }),
                });
                if (!ir.ok) toast.error("Touchpoint logged, but the temperature could not be updated.");
            }
            toast.success("Touchpoint logged.");
            // ID 76: a Lost-type outcome prompts Mark Lost, reason pre-filled —
            // the call alone never closes the lead.
            const savedBucket =
                type === "inside_sales_call" && disposition.disposition
                    ? ((DISPOSITION_BUCKETS as readonly string[]).includes(disposition.bucket)
                          ? disposition.bucket
                          : bucketForLabel(disposition.disposition))
                    : null;
            const lostLabel = savedBucket === "Lost" ? disposition.disposition : null;
            reset();
            onSuccess();
            if (lostLabel && onLostOutcome) onLostOutcome(lostReasonForLabel(lostLabel));
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

                        {type === "inside_sales_call" && changeStatus && toStatus && (
                            <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                                This outcome moves the lead to <strong>{LEAD_STATUS_LABEL[toStatus as LeadStatus] ?? toStatus}</strong>.
                                Commercials stages move only with quotes; Won and Lost have their own buttons.
                            </p>
                        )}
                        {type === "inside_sales_call" && COMMERCIALS_CALL_LABELS.includes(disposition.disposition) &&
                            !hasQuote && (
                                <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                                    No quote in the system — this call does not move the commercials stage.
                                    Create the quote with <strong>Update Commercials</strong>.
                                </p>
                            )}

                        {type === "whatsapp" && (
                            <div className="space-y-2 rounded-md border border-gray-200 p-3">
                                <Label>Screenshot of the chat</Label>
                                <input
                                    type="file"
                                    accept="image/jpeg,image/png,image/webp"
                                    onChange={(e) => setWaScreenshot(e.target.files?.[0] ?? null)}
                                    className="block w-full text-xs"
                                />
                                <label className="flex items-center gap-2 text-sm text-gray-700">
                                    <input
                                        type="checkbox"
                                        checked={waReplied}
                                        onChange={(e) => setWaReplied(e.target.checked)}
                                    />
                                    Dealer replied
                                </label>
                                <p className="text-[11px] text-gray-500">
                                    Counts as contact only with &ldquo;Dealer replied&rdquo; and a screenshot. Without one it is saved as a note.
                                </p>
                            </div>
                        )}

                        {type === "inside_sales_call" && (
                            <div>
                                <Label>
                                    Temperature{" "}
                                    {auto.interest && <span className="text-[11px] text-emerald-700">(auto from call outcome)</span>}
                                </Label>
                                <select
                                    className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm bg-white"
                                    value={toInterest}
                                    onChange={(e) => {
                                        setToInterest(e.target.value as Interest | "");
                                        setTouched((t) => ({ ...t, interest: true }));
                                        setAuto((a) => ({ ...a, interest: false }));
                                    }}
                                >
                                    <option value="">— leave as {lead.interest_level ?? "not set"} —</option>
                                    {INTERESTS.map((i) => (
                                        <option key={i} value={i}>{i}</option>
                                    ))}
                                </select>
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
