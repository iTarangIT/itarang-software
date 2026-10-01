"use client";

// Timeline (Ecofy case events + CRM assignments), Activities (calls / remarks /
// follow-ups) and Appointments. The forms are exported on their own so the
// always-visible CurrentStepCard can show the right one inline.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ECOFY_CALL_OUTCOMES, ECOFY_ROLE_LABEL } from "@/lib/ecofy/access";
import { formatIst } from "../badges";
import { ecofyGet, localToIso, useLeadData, useLookup, type ListItem } from "../client";
import { EpcPartnerPicker } from "../EpcPartnerPicker";
import { Btn, Chip, DateTimeField, Empty, ErrorNote, Field, FormBox, inputCls, KV, Loading, Panel } from "../ui";
import { useCan, useRunner, type TabProps } from "./shared";

// ---------------------------------------------------------------------------
// Timeline — Ecofy's case log merged with the CRM's assignment history
// ---------------------------------------------------------------------------

type TimelineItem = { at: string; kind: string; title: string; detail?: Record<string, unknown>; actor: { fullName: string; role: string | null } | null };
type AssignmentRow = { id: string; created_at: string; reason: string | null; to_role: string | null; from_name: string | null; to_name: string | null; by_name: string | null };
type MergedItem = TimelineItem & { source: "Ecofy" | "CRM" };
type Party = "iTarang" | "Ecofy" | "Platform";

/**
 * Who actually took the action — from the actor's Ecofy role (ITARANG_* vs
 * ECOFY_*), not from which system logged it. CRM-side rows without a role are
 * iTarang by construction; actor-less rows are the platform itself.
 */
export function partyOf(i: { actor: { role: string | null } | null; source?: "Ecofy" | "CRM" }): Party {
    const role = i.actor?.role ?? "";
    if (role.startsWith("ITARANG")) return "iTarang";
    if (role.startsWith("ECOFY")) return "Ecofy";
    if (i.source === "CRM" && i.actor) return "iTarang";
    return "Platform";
}
const PARTY_TONE: Record<Party, "sky" | "green" | "gray"> = { iTarang: "sky", Ecofy: "green", Platform: "gray" };

const flatDetail = (d?: Record<string, unknown>) =>
    d
        ? Object.entries(d)
              .filter(([, v]) => v !== null && v !== undefined && v !== "")
              .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
              .join(" · ")
        : "";

/** Timeline → CSV (Excel-friendly: BOM, CRLF, quoted cells) and trigger a download. */
export function downloadTimelineCsv(fileStem: string, items: MergedItem[]) {
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["When (IST)", "When (ISO)", "Party", "By", "Role", "Kind", "Event", "Details"];
    const rows = items.map((i) => [formatIst(i.at), i.at, partyOf(i), i.actor?.fullName ?? "Platform", i.actor?.role ?? "", i.kind, i.title, flatDetail(i.detail)]);
    const csv = "\uFEFF" + [head, ...rows].map((r) => r.map(q).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileStem}-timeline.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

export function useAssignmentHistory(leadId: string) {
    return useQuery({
        queryKey: ["ecofy-lead", leadId, "assignments"],
        queryFn: () => ecofyGet<{ history: AssignmentRow[] }>(`/api/ecofy/leads/${leadId}/assignments`),
    });
}

function assignmentToItem(h: AssignmentRow): MergedItem {
    const role = h.to_role ? ECOFY_ROLE_LABEL[h.to_role] ?? h.to_role : null;
    const to = `${h.to_name ?? "—"}${role ? ` (${role})` : ""}`;
    return {
        at: h.created_at,
        kind: "crm.assignment",
        title: h.from_name ? `Reassigned ${h.from_name} → ${to}` : `Assigned to ${to}`,
        detail: h.reason ? { reason: h.reason } : undefined,
        actor: h.by_name ? { fullName: h.by_name, role: null } : null,
        source: "CRM",
    };
}

export function TimelineTab({ leadId, c }: TabProps) {
    const q = useLeadData<TimelineItem[]>(leadId, "timeline");
    const a = useAssignmentHistory(leadId);
    const items: MergedItem[] = [
        ...(q.data ?? []).map((i) => ({ ...i, source: "Ecofy" as const })),
        ...(a.data?.history ?? []).map(assignmentToItem),
    ].sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
    const loading = q.isLoading || a.isLoading;

    return (
        <Panel
            title="Timeline"
            right={
                <span className="flex items-center gap-3">
                    <span>Ecofy case events + CRM assignments · newest first</span>
                    <button
                        type="button"
                        disabled={loading || items.length === 0}
                        onClick={() => downloadTimelineCsv(c.caseNo || leadId, items)}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-800 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <span aria-hidden>⤓</span> Download CSV
                    </button>
                </span>
            }
        >
            {loading && <Loading />}
            {q.error ? <ErrorNote error={q.error} /> : null}
            {a.error ? <ErrorNote error={a.error} /> : null}
            {!loading && items.length === 0 && <Empty>Nothing yet.</Empty>}
            <ol className="divide-y divide-gray-100">
                {items.map((i, idx) => {
                    const party = partyOf(i);
                    return (
                        <li key={`${i.source}-${idx}`} className="grid gap-1 py-2 text-sm sm:grid-cols-[150px_1fr] sm:gap-3">
                            <span className="text-xs text-gray-500">{formatIst(i.at)}</span>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <Chip tone={PARTY_TONE[party]}>{party}</Chip>
                                    <span className="font-medium text-gray-900">{i.title}</span>
                                </div>
                                {i.detail && Object.values(i.detail).some(Boolean) && <div className="text-xs text-gray-600">{flatDetail(i.detail)}</div>}
                                <div className="text-[11px] text-gray-400">by {i.actor?.fullName ?? "Platform"}</div>
                            </div>
                        </li>
                    );
                })}
            </ol>
        </Panel>
    );
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

type Activity = { id: number; type: string; callOutcome: string | null; note: string | null; nextFollowUpAt: string | null; at: string; actor: { fullName: string; role: string } | null };

/** Log a call / remark / follow-up / comment. Renders nothing when the viewer may not log. */
export function LogActivityForm(p: TabProps) {
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const [f, setF] = useState({ type: "CALL", callOutcome: "CONNECTED", note: "", nextFollowUpAt: "" });
    if (!can("log_activity")) return null;

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
                <DateTimeField
                    label={f.type === "FOLLOW_UP" ? "Follow-up at (mandatory)" : "Next follow-up"}
                    hint="You get a reminder when it is due."
                    value={f.nextFollowUpAt}
                    required={f.type === "FOLLOW_UP"}
                    onChange={(v) => setF((x) => ({ ...x, nextFollowUpAt: v }))}
                />
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
    );
}

export function ActivitiesTab(p: TabProps) {
    const q = useLeadData<Activity[]>(p.leadId, "activities");
    return (
        <Panel title="Calls, remarks & follow-ups" right="append-only in Ecofy">
            <LogActivityForm {...p} />
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

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export type Appointment = {
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

/** Book a meeting or EPC visit. Renders nothing when the viewer may not book. */
export function BookMeetingForm(p: TabProps) {
    const can = useCan(p);
    const types = useLookup<ListItem>("meeting_type");
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const [f, setF] = useState({ meetingType: "PHONE", scheduledAt: "", bookingRemarks: "", epcPartnerId: "" });
    const typeOptions = types.data?.length ? types.data : MEETING_TYPES.map((code) => ({ code, label: code.replace("_", " ") }));
    if (!can("book_appointment")) return null;

    async function book() {
        const done = await run("Meeting booked", {
            action: "book_appointment",
            meetingType: f.meetingType,
            scheduledAt: localToIso(f.scheduledAt),
            bookingRemarks: f.bookingRemarks || undefined,
            epcPartnerId: f.meetingType === "EPC_VISIT" ? f.epcPartnerId : undefined,
        });
        if (done !== undefined) setF((x) => ({ ...x, scheduledAt: "", bookingRemarks: "" }));
    }

    return (
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
            <DateTimeField
                label="Scheduled at"
                hint="You get a reminder an hour before."
                required
                value={f.scheduledAt}
                onChange={(v) => setF((x) => ({ ...x, scheduledAt: v }))}
            />
            {f.meetingType === "EPC_VISIT" && (
                <EpcPartnerPicker required value={f.epcPartnerId} onChange={(id) => setF((x) => ({ ...x, epcPartnerId: id }))} />
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
    );
}

/** One appointment with its complete / no-show / cancel / reschedule block while SCHEDULED. */
export function AppointmentCard(p: TabProps & { a: Appointment }) {
    const { a } = p;
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const [act, setAct] = useState<{ actualAt?: string; meetingRemarks?: string; outcomeReason?: string; scheduledAt?: string; epcFeedback?: string }>({});
    const setA = (k: string, v: string) => setAct((x) => ({ ...x, [k]: v }));

    function update(op: string) {
        return run(`Meeting ${op.replace("_", "-").toLowerCase()}`, {
            action: "update_appointment",
            appointmentId: a.id,
            op,
            actualAt: localToIso(act.actualAt ?? ""),
            meetingRemarks: act.meetingRemarks,
            outcomeReason: act.outcomeReason,
            scheduledAt: localToIso(act.scheduledAt ?? ""),
            epcFeedback: act.epcFeedback,
        });
    }

    return (
        <div className="rounded-lg border border-gray-200 bg-white p-3 text-sm">
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
                    <DateTimeField label="Actual date & time" value={act.actualAt ?? ""} onChange={(v) => setA("actualAt", v)} />
                    <Field label="Meeting remarks (to complete)">
                        <input className={inputCls} onChange={(e) => setA("meetingRemarks", e.target.value)} />
                    </Field>
                    {a.meetingType === "EPC_VISIT" && (
                        <Field label="EPC feedback" wide>
                            <input className={inputCls} onChange={(e) => setA("epcFeedback", e.target.value)} />
                        </Field>
                    )}
                    <Field label="No-show / cancel reason">
                        <input className={inputCls} onChange={(e) => setA("outcomeReason", e.target.value)} />
                    </Field>
                    <DateTimeField label="New time (to reschedule)" value={act.scheduledAt ?? ""} onChange={(v) => setA("scheduledAt", v)} />
                    <div className="flex flex-wrap gap-2 sm:col-span-2">
                        <Btn variant="success" disabled={busy} onClick={() => update("COMPLETE")}>
                            Mark completed
                        </Btn>
                        <Btn disabled={busy} onClick={() => update("NO_SHOW")}>
                            No-show
                        </Btn>
                        <Btn disabled={busy} onClick={() => update("CANCEL")}>
                            Cancel
                        </Btn>
                        <Btn disabled={busy} onClick={() => update("RESCHEDULE")}>
                            Reschedule
                        </Btn>
                    </div>
                </div>
            )}
        </div>
    );
}

export function AppointmentsTab(p: TabProps) {
    const q = useLeadData<Appointment[]>(p.leadId, "appointments");
    return (
        <Panel title="Meetings & EPC visits" right="scheduled vs actual">
            <BookMeetingForm {...p} />
            {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
            {q.data && q.data.length === 0 && <Empty>No appointments.</Empty>}
            <div className="space-y-3">
                {(q.data ?? []).map((a) => (
                    <AppointmentCard key={a.id} {...p} a={a} />
                ))}
            </div>
        </Panel>
    );
}
