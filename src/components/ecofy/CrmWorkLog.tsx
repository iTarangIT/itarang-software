"use client";

// E-308 — work an Ecofy lead while Ecofy is unavailable. Calls, remarks,
// follow-ups and meeting bookings go through the normal action route; when
// Ecofy cannot take them the route keeps them in the CRM and the ticker replays
// them. Stage moves (assessment, offer, OTP …) still need Ecofy.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { canDoEcofyAction, ECOFY_CALL_OUTCOMES } from "@/lib/ecofy/access";
import { formatIst } from "./badges";
import { ecofyGet, localToIso, runLeadAction } from "./client";
import { Btn, Chip, Empty, Field, FormBox, inputCls, Panel } from "./ui";

type LocalRow = {
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    created_by_name: string | null;
    created_at: string;
    sync_status: string;
    sync_error: string | null;
    synced_at: string | null;
};

// No EPC visit here: it needs Ecofy's EPC-partner list.
const MEETING_TYPES = ["PHONE", "VIDEO", "SITE_VISIT"];

export function useLocalActivities(leadId: string) {
    return useQuery({
        queryKey: ["ecofy-lead", leadId, "local-activities"],
        queryFn: async () => (await ecofyGet<{ activities: LocalRow[] }>(`/api/ecofy/leads/${leadId}/local-activities`)).activities,
    });
}

export function CrmWorkLog({
    leadId,
    viewer,
    assignedTo,
    stage,
}: {
    leadId: string;
    viewer: { id: string; role: string };
    assignedTo: string | null;
    stage: string | null;
}) {
    const router = useRouter();
    const qc = useQueryClient();
    const list = useLocalActivities(leadId);
    const leadView = { assigned_to_user_id: assignedTo, stage };
    const canLog = canDoEcofyAction(viewer, leadView, "log_activity");
    const canBook = canDoEcofyAction(viewer, leadView, "book_appointment");
    const [busy, setBusy] = useState(false);
    const [a, setA] = useState({ type: "CALL", callOutcome: "CONNECTED", note: "", nextFollowUpAt: "" });
    const [m, setM] = useState({ meetingType: "PHONE", scheduledAt: "", bookingRemarks: "" });

    async function send(body: Record<string, unknown>, done: () => void) {
        setBusy(true);
        try {
            const r = await runLeadAction(leadId, body);
            toast.success(r.savedLocally ? "Saved in the CRM — it will be sent to Ecofy when Ecofy is back" : "Recorded in Ecofy");
            done();
            qc.invalidateQueries({ queryKey: ["ecofy-lead", leadId] });
            router.refresh();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not save");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-4">
            {!canLog && !canBook && <p className="text-sm text-gray-600">Only the person the lead is assigned to (or the Sales Head) can record work on it.</p>}
            {canLog && (
                <Panel title="Log a call, remark or follow-up" right="saved in the CRM while Ecofy is unavailable">
                    <FormBox
                        onSubmit={() =>
                            send(
                                {
                                    action: "log_activity",
                                    type: a.type,
                                    callOutcome: a.type === "CALL" ? a.callOutcome : undefined,
                                    note: a.note || undefined,
                                    nextFollowUpAt: localToIso(a.nextFollowUpAt),
                                },
                                () => setA((x) => ({ ...x, note: "", nextFollowUpAt: "" })),
                            )
                        }
                    >
                        <Field label="Type">
                            <select className={inputCls} value={a.type} onChange={(e) => setA((x) => ({ ...x, type: e.target.value }))}>
                                {["CALL", "REMARK", "FOLLOW_UP", "COMMENT"].map((t) => (
                                    <option key={t} value={t}>
                                        {t.replace("_", "-").toLowerCase()}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        {a.type === "CALL" && (
                            <Field label="Outcome (mandatory)">
                                <select className={inputCls} value={a.callOutcome} onChange={(e) => setA((x) => ({ ...x, callOutcome: e.target.value }))}>
                                    {ECOFY_CALL_OUTCOMES.map((o) => (
                                        <option key={o} value={o}>
                                            {o.replace(/_/g, " ").toLowerCase()}
                                        </option>
                                    ))}
                                </select>
                            </Field>
                        )}
                        {(a.type === "FOLLOW_UP" || a.type === "CALL") && (
                            <Field label={a.type === "FOLLOW_UP" ? "Follow-up at (mandatory)" : "Next follow-up"} hint="You get a reminder when it is due.">
                                <input
                                    type="datetime-local"
                                    required={a.type === "FOLLOW_UP"}
                                    className={inputCls}
                                    value={a.nextFollowUpAt}
                                    onChange={(e) => setA((x) => ({ ...x, nextFollowUpAt: e.target.value }))}
                                />
                            </Field>
                        )}
                        <Field label="Note" wide>
                            <textarea rows={2} className={inputCls} value={a.note} onChange={(e) => setA((x) => ({ ...x, note: e.target.value }))} />
                        </Field>
                        <div className="flex justify-end sm:col-span-2">
                            <Btn type="submit" variant="primary" disabled={busy}>
                                Log
                            </Btn>
                        </div>
                    </FormBox>
                </Panel>
            )}
            {canBook && (
                <Panel title="Book a meeting" right="EPC visits need Ecofy">
                    <FormBox
                        onSubmit={() =>
                            send(
                                {
                                    action: "book_appointment",
                                    meetingType: m.meetingType,
                                    scheduledAt: localToIso(m.scheduledAt),
                                    bookingRemarks: m.bookingRemarks || undefined,
                                },
                                () => setM((x) => ({ ...x, scheduledAt: "", bookingRemarks: "" })),
                            )
                        }
                    >
                        <Field label="Type">
                            <select className={inputCls} value={m.meetingType} onChange={(e) => setM((x) => ({ ...x, meetingType: e.target.value }))}>
                                {MEETING_TYPES.map((t) => (
                                    <option key={t} value={t}>
                                        {t.replace("_", " ").toLowerCase()}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Scheduled at" hint="You get a reminder an hour before.">
                            <input type="datetime-local" required className={inputCls} value={m.scheduledAt} onChange={(e) => setM((x) => ({ ...x, scheduledAt: e.target.value }))} />
                        </Field>
                        <Field label="Booking remarks" wide>
                            <input className={inputCls} value={m.bookingRemarks} onChange={(e) => setM((x) => ({ ...x, bookingRemarks: e.target.value }))} />
                        </Field>
                        <div className="flex justify-end sm:col-span-2">
                            <Btn type="submit" variant="primary" disabled={busy || !m.scheduledAt}>
                                Book
                            </Btn>
                        </div>
                    </FormBox>
                </Panel>
            )}
            <LocalActivityList leadId={leadId} rows={list.data} loading={list.isLoading} />
        </div>
    );
}

export function LocalActivityList({ rows, loading, onlyUnsynced }: { leadId: string; rows?: LocalRow[]; loading?: boolean; onlyUnsynced?: boolean }) {
    const shown = (rows ?? []).filter((r) => !onlyUnsynced || r.sync_status !== "synced");
    if (onlyUnsynced && shown.length === 0) return null;
    return (
        <Panel title="Recorded in the CRM" right="sent to Ecofy automatically every 5 minutes">
            {loading && <p className="text-sm text-gray-500">Loading…</p>}
            {!loading && shown.length === 0 && <Empty>Nothing recorded in the CRM yet.</Empty>}
            <ol className="divide-y divide-gray-100">
                {shown.map((r) => {
                    const p = r.payload as {
                        type?: string;
                        callOutcome?: string;
                        note?: string;
                        nextFollowUpAt?: string;
                        meetingType?: string;
                        scheduledAt?: string;
                        bookingRemarks?: string;
                    };
                    return (
                        <li key={r.id} className="grid gap-1 py-2 text-sm sm:grid-cols-[150px_1fr] sm:gap-3">
                            <span className="text-xs text-gray-500">{formatIst(r.created_at)}</span>
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium">
                                        {r.kind === "appointment"
                                            ? `Meeting booked (${(p.meetingType ?? "").replace("_", " ").toLowerCase()}) for ${formatIst(p.scheduledAt)}`
                                            : `${p.type ?? "Activity"}${p.callOutcome ? ` · ${p.callOutcome.replace(/_/g, " ").toLowerCase()}` : ""}`}
                                    </span>
                                    {r.sync_status === "synced" ? (
                                        <Chip tone="green">sent to Ecofy</Chip>
                                    ) : r.sync_status === "failed" ? (
                                        <Chip tone="red">Ecofy rejected it</Chip>
                                    ) : (
                                        <Chip tone="amber">waiting for Ecofy</Chip>
                                    )}
                                </div>
                                {(p.note || p.bookingRemarks) && <div className="text-gray-700">{p.note ?? p.bookingRemarks}</div>}
                                {p.nextFollowUpAt && <div className="text-xs text-gray-500">next follow-up {formatIst(p.nextFollowUpAt)}</div>}
                                {r.sync_status === "failed" && r.sync_error && <div className="text-xs text-red-700">{r.sync_error}</div>}
                                <div className="text-[11px] text-gray-400">{r.created_by_name}</div>
                            </div>
                        </li>
                    );
                })}
            </ol>
        </Panel>
    );
}
