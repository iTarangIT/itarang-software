"use client";

// Shared ASM visit form — the field group, its state, validation and the
// POST to /api/asm/lead/[id]/visit. Used both by the dedicated LogVisitModal
// and by the "visit" branch of the Log Touchpoint modal so the two stay in
// lock-step. useVisitForm() owns the state; <VisitFields> renders it.

import { useEffect, useState } from "react";
import { autoProgressForVisit, type Interest } from "@/lib/leads/autoProgress";
import { toast } from "sonner";
import { CheckCircle2, Loader2, MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { PhotoUploader } from "./PhotoUploader";
import {
    VISIT_STATUS,
    VISIT_OUTCOME,
    VISIT_OUTCOME_LABELS,
    VISIT_NEXT_ACTION,
    type VisitNextAction,
    type VisitOutcome,
    type VisitStatus,
} from "@/lib/asm/types";

const STATUS_LABELS: Record<VisitStatus, string> = {
    pending_scheduling: "Pending scheduling",
    scheduled: "Scheduled",
    visited: "Visited",
    postponed: "Postponed",
    cancelled: "Cancelled",
    no_show: "No show",
};

const NEXT_ACTION_LABELS: Record<VisitNextAction, string> = {
    next_visit: "Schedule another visit",
    convert: "Mark Converted",
    lost: "Mark Lost",
    escalate: "Escalate",
};

export type VisitSaveResult = { next_action: VisitNextAction };

export type UseVisitForm = ReturnType<typeof useVisitForm>;

/**
 * Owns the visit form state and the save call. Resets whenever `open` flips
 * to false so a reopened modal always starts clean.
 */
/** Statuses a visit may move a lead to (the visit route's VISIT_STATUS_TARGETS). */
const VISIT_STATUS_TARGETS = [
    "Under_Discussion",
    "Commercials_Explained",
    "Awaiting_Customer_Decision",
    "Commercials_Finalised",
] as const;
type VisitStatusTarget = (typeof VISIT_STATUS_TARGETS)[number];

/** The lead as the form needs it to pre-fill status / temperature. */
export type VisitLeadState = { lead_status: string | null; interest_level: string | null };

export function useVisitForm(open: boolean, lead?: VisitLeadState) {
    const today = new Date().toISOString().slice(0, 10);
    const [visitStatus, setVisitStatus] = useState<VisitStatus>("visited");
    const [actualDate, setActualDate] = useState(today);
    const [outcome, setOutcome] = useState<VisitOutcome | "">("productive");
    const [remarks, setRemarks] = useState("");
    const [photos, setPhotos] = useState<string[]>([]);
    const [lat, setLat] = useState<number | null>(null);
    const [lng, setLng] = useState<number | null>(null);
    const [gpsState, setGpsState] = useState<
        "idle" | "loading" | "ok" | "denied" | "error"
    >("idle");
    const [nextAction, setNextAction] = useState<VisitNextAction>("next_visit");
    const [nextVisitDate, setNextVisitDate] = useState("");
    const [submitting, setSubmitting] = useState(false);
    // Status / temperature to save with the visit ("" = leave as is), filled
    // from the shared auto rule (lib/leads/autoProgress.ts) until the ASM
    // changes them — the same values the WhatsApp Assistant proposes.
    const [statusTo, setStatusToRaw] = useState<VisitStatusTarget | "">("");
    const [interestTo, setInterestToRaw] = useState<Interest | "">("");
    const [auto, setAuto] = useState({ status: false, interest: false });
    const [touched, setTouched] = useState({ status: false, interest: false });
    const setStatusTo = (v: VisitStatusTarget | "") => {
        setStatusToRaw(v);
        setTouched((t) => ({ ...t, status: true }));
        setAuto((a) => ({ ...a, status: false }));
    };
    const setInterestTo = (v: Interest | "") => {
        setInterestToRaw(v);
        setTouched((t) => ({ ...t, interest: true }));
        setAuto((a) => ({ ...a, interest: false }));
    };

    useEffect(() => {
        if (!lead) return;
        const derived = autoProgressForVisit({
            visited: visitStatus === "visited",
            outcome: visitStatus === "visited" && outcome ? outcome : null,
            currentStatus: lead.lead_status,
            currentInterest: lead.interest_level,
        });
        const status = (VISIT_STATUS_TARGETS as readonly string[]).includes(derived.statusTo ?? "")
            ? (derived.statusTo as VisitStatusTarget)
            : "";
        if (!touched.status) setStatusToRaw(status);
        if (!touched.interest) setInterestToRaw(derived.interestTo ?? "");
        setAuto({ status: !touched.status && !!status, interest: !touched.interest && !!derived.interestTo });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- re-derive only when the outcome changes
    }, [visitStatus, outcome, lead?.lead_status, lead?.interest_level]);

    useEffect(() => {
        if (!open) {
            setVisitStatus("visited");
            setActualDate(today);
            setOutcome("productive");
            setRemarks("");
            setPhotos([]);
            setLat(null);
            setLng(null);
            setGpsState("idle");
            setNextAction("next_visit");
            setNextVisitDate("");
            setSubmitting(false);
        }
    }, [open, today]);

    const captureGps = () => {
        if (!("geolocation" in navigator)) {
            setGpsState("error");
            toast.error("Geolocation not available on this device");
            return;
        }
        setGpsState("loading");
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setLat(Number(pos.coords.latitude.toFixed(6)));
                setLng(Number(pos.coords.longitude.toFixed(6)));
                setGpsState("ok");
                toast.success("Location captured");
            },
            (err) => {
                if (err.code === err.PERMISSION_DENIED) {
                    setGpsState("denied");
                    toast.message("Permission denied — proceed without GPS");
                } else {
                    setGpsState("error");
                    toast.error(`GPS error: ${err.message}`);
                }
            },
            { enableHighAccuracy: true, timeout: 8000 },
        );
    };

    /**
     * Validates, posts the visit, and returns the next_action on success
     * (so the caller can chain into the Convert / Lost / Escalate modal).
     * Returns null on validation failure or request error.
     */
    const submit = async (leadId: string): Promise<VisitSaveResult | null> => {
        if (!remarks.trim()) {
            toast.error("Visit remarks are required.");
            return null;
        }
        if (visitStatus === "visited" && !outcome) {
            toast.error("Outcome is required for a completed visit.");
            return null;
        }
        if (nextAction === "next_visit" && !nextVisitDate) {
            toast.error("Next visit date is required.");
            return null;
        }

        setSubmitting(true);
        try {
            const body: Record<string, unknown> = {
                visit_status: visitStatus,
                visit_remarks: remarks.trim(),
                next_action: nextAction,
            };
            if (visitStatus === "visited") {
                body.actual_visit_date = actualDate;
                body.visit_outcome = outcome || null;
            } else if (visitStatus === "scheduled" && actualDate) {
                body.scheduled_date = actualDate;
            }
            if (photos.length) body.photos = photos;
            if (lat != null) body.gps_check_in_lat = lat;
            if (lng != null) body.gps_check_in_lng = lng;
            if (nextAction === "next_visit") body.next_visit_date = nextVisitDate;
            if (visitStatus === "visited" && statusTo) body.status_to = statusTo;
            if (visitStatus === "visited" && interestTo && interestTo !== lead?.interest_level) {
                body.interest_level = interestTo;
                body.interest_auto = auto.interest;
            }

            const res = await fetch(
                `/api/asm/lead/${encodeURIComponent(leadId)}/visit`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                },
            );
            const json = await res.json();
            if (!res.ok) {
                // A zod rejection comes back as a bare "Validation failed" with
                // the offending fields in error.details — append them so the
                // ASM sees which field the server refused, not just that it did.
                const details = Array.isArray(json?.error?.details)
                    ? json.error.details
                          .map((d: { path?: string; message?: string }) =>
                              [d.path, d.message].filter(Boolean).join(": "),
                          )
                          .filter(Boolean)
                          .join("; ")
                    : "";
                const message = json?.error?.message ?? "Failed to log visit";
                throw new Error(details ? `${message} — ${details}` : message);
            }
            toast.success("Visit logged.");
            return { next_action: nextAction };
        } catch (err) {
            toast.error((err as Error).message);
            return null;
        } finally {
            setSubmitting(false);
        }
    };

    return {
        visitStatus,
        setVisitStatus,
        actualDate,
        setActualDate,
        outcome,
        setOutcome,
        remarks,
        setRemarks,
        photos,
        setPhotos,
        lat,
        lng,
        gpsState,
        captureGps,
        nextAction,
        setNextAction,
        nextVisitDate,
        setNextVisitDate,
        submitting,
        submit,
        lead,
        statusTo,
        setStatusTo,
        interestTo,
        setInterestTo,
        auto,
    };
}

export function VisitFields({ form }: { form: UseVisitForm }) {
    const {
        visitStatus,
        setVisitStatus,
        actualDate,
        setActualDate,
        outcome,
        setOutcome,
        remarks,
        setRemarks,
        photos,
        setPhotos,
        lat,
        lng,
        gpsState,
        captureGps,
        nextAction,
        setNextAction,
        nextVisitDate,
        setNextVisitDate,
        submitting,
        lead,
        statusTo,
        setStatusTo,
        interestTo,
        setInterestTo,
        auto,
    } = form;

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                    <Label>Visit status</Label>
                    <select
                        className="mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
                        value={visitStatus}
                        onChange={(e) => setVisitStatus(e.target.value as VisitStatus)}
                    >
                        {VISIT_STATUS.map((s) => (
                            <option key={s} value={s}>
                                {STATUS_LABELS[s]}
                            </option>
                        ))}
                    </select>
                </div>
                <div>
                    <Label>
                        {visitStatus === "visited"
                            ? "Actual visit date"
                            : "Scheduled date"}
                    </Label>
                    <Input
                        type="date"
                        value={actualDate}
                        onChange={(e) => setActualDate(e.target.value)}
                        className="mt-1"
                    />
                </div>
            </div>

            {visitStatus === "visited" && (
                <div>
                    <Label>
                        Outcome <span className="text-rose-600">*</span>
                    </Label>
                    <select
                        className="mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
                        value={outcome}
                        onChange={(e) =>
                            setOutcome(e.target.value as VisitOutcome | "")
                        }
                    >
                        <option value="">— select —</option>
                        {VISIT_OUTCOME.map((o) => (
                            <option key={o} value={o}>
                                {VISIT_OUTCOME_LABELS[o]}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            {visitStatus === "visited" && lead && (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div>
                        <Label>
                            Lead status after visit{" "}
                            {auto.status && <span className="text-[11px] text-emerald-700">(auto)</span>}
                        </Label>
                        <select
                            className="mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
                            value={statusTo}
                            onChange={(e) => setStatusTo(e.target.value as VisitStatusTarget | "")}
                        >
                            <option value="">— leave as {(lead.lead_status ?? "not set").replace(/_/g, " ")} —</option>
                            {VISIT_STATUS_TARGETS.map((s) => (
                                <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <Label>
                            Temperature{" "}
                            {auto.interest && <span className="text-[11px] text-emerald-700">(auto)</span>}
                        </Label>
                        <select
                            className="mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
                            value={interestTo}
                            onChange={(e) => setInterestTo(e.target.value as Interest | "")}
                        >
                            <option value="">— leave as {lead.interest_level ?? "not set"} —</option>
                            {(["hot", "warm", "cold"] as const).map((i) => (
                                <option key={i} value={i}>{i}</option>
                            ))}
                        </select>
                    </div>
                </div>
            )}

            <div>
                <Label>
                    Visit remarks <span className="text-rose-600">*</span>
                </Label>
                <textarea
                    className="mt-1 min-h-[96px] w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    placeholder="What happened on the ground?"
                />
            </div>

            <div>
                <Label>Photos</Label>
                <div className="mt-1">
                    <PhotoUploader
                        value={photos}
                        onChange={setPhotos}
                        disabled={submitting}
                    />
                </div>
            </div>

            <div>
                <Label>GPS check-in</Label>
                <div className="mt-1 flex items-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={captureGps}
                        disabled={gpsState === "loading"}
                        className="inline-flex items-center gap-1.5"
                    >
                        {gpsState === "loading" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <MapPin className="h-3.5 w-3.5" />
                        )}
                        Capture location
                    </Button>
                    {gpsState === "ok" && lat != null && lng != null && (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {lat.toFixed(4)}, {lng.toFixed(4)}
                        </span>
                    )}
                    {gpsState === "denied" && (
                        <span className="text-xs text-amber-700">
                            Permission denied — proceeding without GPS
                        </span>
                    )}
                    {gpsState === "error" && (
                        <span className="text-xs text-rose-700">
                            Couldn&apos;t get location
                        </span>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-1 gap-3 border-t border-gray-100 pt-2 md:grid-cols-2">
                <div>
                    <Label>Next action</Label>
                    <select
                        className="mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
                        value={nextAction}
                        onChange={(e) =>
                            setNextAction(e.target.value as VisitNextAction)
                        }
                    >
                        {VISIT_NEXT_ACTION.map((n) => (
                            <option key={n} value={n}>
                                {NEXT_ACTION_LABELS[n]}
                            </option>
                        ))}
                    </select>
                    <p className="mt-1 text-[11px] text-gray-500">
                        convert / lost / escalate will open the matching modal
                        after the visit saves.
                    </p>
                </div>
                {nextAction === "next_visit" && (
                    <div>
                        <Label>
                            Next visit date{" "}
                            <span className="text-rose-600">*</span>
                        </Label>
                        <Input
                            type="date"
                            value={nextVisitDate}
                            onChange={(e) => setNextVisitDate(e.target.value)}
                            className="mt-1"
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
