"use client";

// Timeline, Activities (calls / remarks / follow-ups) and Appointments.

import { useState } from "react";
import { ECOFY_CALL_OUTCOMES } from "@/lib/ecofy/access";
import { formatIst } from "../badges";
import { localToIso, useLeadData, useLookup, type EpcPartner, type ListItem } from "../client";
import { Btn, Chip, Empty, ErrorNote, Field, FormBox, inputCls, KV, Loading, Panel } from "../ui";
import { useCan, useRunner, type TabProps } from "./shared";

type TimelineItem = { at: string; kind: string; title: string; detail?: Record<string, unknown>; actor: { fullName: string; role: string | null } | null };

export function TimelineTab({ leadId }: TabProps) {
    const q = useLeadData<TimelineItem[]>(leadId, "timeline");
    return (
        <Panel title="Timeline" right="everything recorded on the case in Ecofy">
            {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
            {q.data && q.data.length === 0 && <Empty>Nothing yet.</Empty>}
            <ol className="divide-y divide-gray-100">
                {(q.data ?? []).map((i, idx) => (
                    <li key={idx} className="grid gap-1 py-2 text-sm sm:grid-cols-[150px_1fr] sm:gap-3">
                        <span className="text-xs text-gray-500">{formatIst(i.at)}</span>
                        <div>
                            <div className="font-medium text-gray-900">{i.title}</div>
                            {i.detail && Object.values(i.detail).some(Boolean) && (
                                <div className="text-xs text-gray-600">
                                    {Object.entries(i.detail)
                                        .filter(([, v]) => v !== null && v !== undefined && v !== "")
                                        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                                        .join(" · ")}
                                </div>
                            )}
                            <div className="text-[11px] text-gray-400">by {i.actor?.fullName ?? "Platform"}</div>
                        </div>
                    </li>
                ))}
            </ol>
        </Panel>
    );
}

type Activity = { id: number; type: string; callOutcome: string | null; note: string | null; nextFollowUpAt: string | null; at: string; actor: { fullName: string; role: string } | null };

export function ActivitiesTab(p: TabProps) {
    const q = useLeadData<Activity[]>(p.leadId, "activities");
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const [f, setF] = useState({ type: "CALL", callOutcome: "CONNECTED", note: "", nextFollowUpAt: "" });

    async function submit() {
        const done = await run("Logged", {
            action: "log_activity",
            type: f.type,
            callOutcome: f.type === "CALL" ? f.callOutcome : undefined,
            note: f.note || undefined,
            nextFollowUpAt: localToIso(f.nextFollowUpAt),
        });
        if (done !== undefined) setF((x) => ({ ...x, note: "", nextFollowUpAt: "" }));
    }

    return (
        <Panel title="Calls, remarks & follow-ups" right="append-only in Ecofy">
            {can("log_activity") && (
                <FormBox onSubmit={submit}>
                    <Field label="Type">
                        <select className={inputCls} value={f.type} onChange={(e) => setF((x) => ({ ...x, type: e.target.value }))}>
                            {["CALL", "REMARK", "FOLLOW_UP", "COMMENT"].map((t) => (
                                <option key={t} value={t}>
                                    {t.replace("_", "-").toLowerCase()}
                                </option>
                            ))}
                        </select>
                    </Field>
                    {f.type === "CALL" && (
                        <Field label="Outcome (mandatory)">
                            <select className={inputCls} value={f.callOutcome} onChange={(e) => setF((x) => ({ ...x, callOutcome: e.target.value }))}>
                                {ECOFY_CALL_OUTCOMES.map((o) => (
                                    <option key={o} value={o}>
                                        {o.replace(/_/g, " ").toLowerCase()}
                                    </option>
                                ))}
                            </select>
                        </Field>
                    )}
                    {(f.type === "FOLLOW_UP" || f.type === "CALL") && (
                        <Field label={f.type === "FOLLOW_UP" ? "Follow-up at (mandatory)" : "Next follow-up"} hint="You get a reminder when it is due.">
                            <input
                                type="datetime-local"
                                className={inputCls}
                                value={f.nextFollowUpAt}
                                required={f.type === "FOLLOW_UP"}
                                onChange={(e) => setF((x) => ({ ...x, nextFollowUpAt: e.target.value }))}
                            />
                        </Field>
                    )}
                    <Field label="Note" wide>
                        <textarea className={inputCls} rows={2} value={f.note} onChange={(e) => setF((x) => ({ ...x, note: e.target.value }))} />
                    </Field>
                    <div className="flex justify-end sm:col-span-2">
                        <Btn type="submit" variant="primary" disabled={busy}>
                            Log
                        </Btn>
                    </div>
                </FormBox>
            )}
            {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
            {q.data && q.data.length === 0 && <Empty>No activities yet.</Empty>}
            <ol className="divide-y divide-gray-100">
                {(q.data ?? [])
                    .slice()
                    .reverse()
                    .map((a) => (
                        <li key={a.id} className="grid gap-1 py-2 text-sm sm:grid-cols-[150px_1fr] sm:gap-3">
                            <span className="text-xs text-gray-500">{formatIst(a.at)}</span>
                            <div>
                                <span className="font-medium">
                                    {a.type}
                                    {a.callOutcome ? ` · ${a.callOutcome.replace(/_/g, " ").toLowerCase()}` : ""}
                                </span>
                                {a.note && <span className="text-gray-700"> — {a.note}</span>}
                                {a.nextFollowUpAt && <div className="text-xs text-gray-500">next follow-up {formatIst(a.nextFollowUpAt)}</div>}
                                <div className="text-[11px] text-gray-400">{a.actor?.fullName}</div>
                            </div>
                        </li>
                    ))}
            </ol>
        </Panel>
    );
}

type Appointment = {
    id: string;
    meetingType: string;
    scheduledAt: string;
    status: string;
    bookingRemarks: string | null;
    actualAt: string | null;
    meetingRemarks: string | null;
    outcomeReason: string | null;
    epcPartnerId: string | null;
    epcFeedback: string | null;
    rescheduledFrom: string | null;
};

const MEETING_TYPES = ["PHONE", "VIDEO", "SITE_VISIT", "EPC_VISIT"];

export function AppointmentsTab(p: TabProps) {
    const q = useLeadData<Appointment[]>(p.leadId, "appointments");
    const can = useCan(p);
    const types = useLookup<ListItem>("meeting_type");
    const epcs = useLookup<EpcPartner>("epc-partners");
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const [f, setF] = useState({ meetingType: "PHONE", scheduledAt: "", bookingRemarks: "", epcPartnerId: "" });
    const [act, setAct] = useState<Record<string, { actualAt?: string; meetingRemarks?: string; outcomeReason?: string; scheduledAt?: string; epcFeedback?: string }>>({});
    const typeOptions = types.data?.length ? types.data : MEETING_TYPES.map((code) => ({ code, label: code.replace("_", " ") }));

    async function book() {
        await run("Meeting booked", {
            action: "book_appointment",
            meetingType: f.meetingType,
            scheduledAt: localToIso(f.scheduledAt),
            bookingRemarks: f.bookingRemarks || undefined,
            epcPartnerId: f.meetingType === "EPC_VISIT" ? f.epcPartnerId : undefined,
        });
    }
    function update(id: string, op: string) {
        const a = act[id] ?? {};
        return run(`Meeting ${op.replace("_", "-").toLowerCase()}`, {
            action: "update_appointment",
            appointmentId: id,
            op,
            actualAt: localToIso(a.actualAt ?? ""),
            meetingRemarks: a.meetingRemarks,
            outcomeReason: a.outcomeReason,
            scheduledAt: localToIso(a.scheduledAt ?? ""),
            epcFeedback: a.epcFeedback,
        });
    }
    const setA = (id: string, k: string, v: string) => setAct((x) => ({ ...x, [id]: { ...x[id], [k]: v } }));

    return (
        <Panel title="Meetings & EPC visits" right="scheduled vs actual">
            {can("book_appointment") && (
                <FormBox onSubmit={book}>
                    <Field label="Type">
                        <select className={inputCls} value={f.meetingType} onChange={(e) => setF((x) => ({ ...x, meetingType: e.target.value }))}>
                            {typeOptions.map((t) => (
                                <option key={t.code} value={t.code}>
                                    {t.label}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <Field label="Scheduled at" hint="You get a reminder an hour before.">
                        <input type="datetime-local" required className={inputCls} value={f.scheduledAt} onChange={(e) => setF((x) => ({ ...x, scheduledAt: e.target.value }))} />
                    </Field>
                    {f.meetingType === "EPC_VISIT" && (
                        <Field label="EPC partner">
                            <select required className={inputCls} value={f.epcPartnerId} onChange={(e) => setF((x) => ({ ...x, epcPartnerId: e.target.value }))}>
                                <option value="">—</option>
                                {(epcs.data ?? [])
                                    .filter((e) => e.active)
                                    .map((e) => (
                                        <option key={e.id} value={e.id}>
                                            {e.name}
                                        </option>
                                    ))}
                            </select>
                        </Field>
                    )}
                    <Field label="Booking remarks" wide={f.meetingType !== "EPC_VISIT"}>
                        <input className={inputCls} value={f.bookingRemarks} onChange={(e) => setF((x) => ({ ...x, bookingRemarks: e.target.value }))} />
                    </Field>
                    <div className="flex justify-end sm:col-span-2">
                        <Btn type="submit" variant="primary" disabled={busy || !f.scheduledAt}>
                            Book
                        </Btn>
                    </div>
                </FormBox>
            )}
            {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
            {q.data && q.data.length === 0 && <Empty>No appointments.</Empty>}
            <div className="space-y-3">
                {(q.data ?? []).map((a) => (
                    <div key={a.id} className="rounded-lg border border-gray-200 p-3 text-sm">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                            <b>{a.meetingType.replace("_", " ")}</b>
                            <Chip tone={a.status === "COMPLETED" ? "green" : a.status === "SCHEDULED" ? "sky" : "gray"}>{a.status}</Chip>
                            {a.rescheduledFrom && <span className="text-xs text-gray-500">rescheduled</span>}
                        </div>
                        <KV
                            rows={[
                                ["Scheduled", formatIst(a.scheduledAt)],
                                ["Actual", a.actualAt ? formatIst(a.actualAt) : null],
                                ["Booking remarks", a.bookingRemarks],
                                ["Meeting remarks", a.meetingRemarks],
                                ...(a.outcomeReason ? ([["Reason", a.outcomeReason]] as Array<[string, string]>) : []),
                                ...(a.meetingType === "EPC_VISIT" ? ([["EPC feedback", a.epcFeedback]] as Array<[string, string | null]>) : []),
                            ]}
                        />
                        {can("update_appointment") && a.status === "SCHEDULED" && (
                            <div className="mt-3 grid gap-2 border-t border-gray-100 pt-3 sm:grid-cols-2">
                                <Field label="Actual date & time">
                                    <input type="datetime-local" className={inputCls} onChange={(e) => setA(a.id, "actualAt", e.target.value)} />
                                </Field>
                                <Field label="Meeting remarks (to complete)">
                                    <input className={inputCls} onChange={(e) => setA(a.id, "meetingRemarks", e.target.value)} />
                                </Field>
                                {a.meetingType === "EPC_VISIT" && (
                                    <Field label="EPC feedback" wide>
                                        <input className={inputCls} onChange={(e) => setA(a.id, "epcFeedback", e.target.value)} />
                                    </Field>
                                )}
                                <Field label="No-show / cancel reason">
                                    <input className={inputCls} onChange={(e) => setA(a.id, "outcomeReason", e.target.value)} />
                                </Field>
                                <Field label="New time (to reschedule)">
                                    <input type="datetime-local" className={inputCls} onChange={(e) => setA(a.id, "scheduledAt", e.target.value)} />
                                </Field>
                                <div className="flex flex-wrap gap-2 sm:col-span-2">
                                    <Btn variant="success" disabled={busy} onClick={() => update(a.id, "COMPLETE")}>
                                        Mark completed
                                    </Btn>
                                    <Btn disabled={busy} onClick={() => update(a.id, "NO_SHOW")}>
                                        No-show
                                    </Btn>
                                    <Btn disabled={busy} onClick={() => update(a.id, "CANCEL")}>
                                        Cancel
                                    </Btn>
                                    <Btn disabled={busy} onClick={() => update(a.id, "RESCHEDULE")}>
                                        Reschedule
                                    </Btn>
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </Panel>
    );
}
