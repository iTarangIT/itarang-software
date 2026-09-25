"use client";

// The action panel for the lead's current stage — mirrors Ecofy's StepPanel,
// with the Sales Head in the iTarang Admin seat and ASM / ISR as callers.

import { useState } from "react";
import { ECOFY_CLOSURE_REASONS, ECOFY_RETURN_REASONS } from "@/lib/ecofy/access";
import { useLookup, type Financier, type ListItem } from "../client";
import { Btn, Field, inputCls, Panel } from "../ui";
import { pretty, useCan, useRunner, type TabProps } from "./shared";

export function CurrentStepTab(p: TabProps) {
    const { c } = p;
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const [reopenReason, setReopenReason] = useState("");
    const financiers = useLookup<Financier>("financiers", can("route_financier"));
    const [route, setRoute] = useState({ financierId: "", note: "" });

    const say = (t: string) => <p className="text-sm text-gray-600">{t}</p>;

    return (
        <Panel title="Current step" right={`${c.stage}${c.subStatus ? ` · ${pretty(c.subStatus)}` : ""}`}>
            <div className="space-y-4">
                {c.stage === "S0" && say("The lead is back with Ecofy for qualification. Nothing to do here until Ecofy pushes it again.")}
                {c.stage === "S1" &&
                    say(
                        can("assign")
                            ? "New in the pickup queue. Assign it to an ASM or ISR (panel above) — that moves it to follow-up (S2) in Ecofy — or return it to Ecofy."
                            : "Waiting for the Sales Head to assign it.",
                    )}
                {c.stage === "S2" &&
                    say("Call the customer and log it (Activities), book a meeting or EPC visit (Appointments). Gate to S3: at least one completed meeting.")}
                {c.stage === "S3" && say("Record the assessment in the Assessment tab and confirm it to move to the offer stage (S4).")}
                {c.stage === "S4" &&
                    say("Offer tab: send for eligibility, upload the EPC quote PDF, compose the offer and send the OTP to the customer (S4 → S5).")}
                {c.stage === "S5" && say("OTP sent to the customer. Enter the code in the Offer tab; on verification the File is locked (S5 → S6).")}
                {c.stage === "S6" && say("File locked — awaiting the financier's decision (Financing tab). Installation may be created in parallel.")}
                {c.stage === "S7" && say("Sanction recorded. Track the installation; the disbursement moves the case to S8.")}
                {c.stage === "S8" && say("Disbursed — the asset is active. EMI status and asset events are recorded by Ecofy.")}
                {c.stage === "CLOSED" && say(`Closed: ${pretty(c.closureReason)}${c.closureNote ? ` — ${c.closureNote}` : ""}.`)}

                {can("advance") && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
                        <Btn variant="primary" disabled={busy} onClick={() => run("Moved to assessment (S3)", { action: "advance", version: c.version })}>
                            Advance to assessment →
                        </Btn>
                    </div>
                )}

                {can("route_financier") && (c.subStatus === "NOT_ELIGIBLE" || c.subStatus === "REJECTED_ROUTING") && (
                    <div className="grid gap-2 border-t border-gray-100 pt-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                        <Field label="Route to financier">
                            <select className={inputCls} value={route.financierId} onChange={(e) => setRoute((r) => ({ ...r, financierId: e.target.value }))}>
                                <option value="">—</option>
                                {(financiers.data ?? [])
                                    .filter((f) => f.active && f.id !== c.financierId)
                                    .map((f) => (
                                        <option key={f.id} value={f.id}>
                                            {f.name}
                                        </option>
                                    ))}
                            </select>
                        </Field>
                        <Field label="Note">
                            <input className={inputCls} value={route.note} onChange={(e) => setRoute((r) => ({ ...r, note: e.target.value }))} />
                        </Field>
                        <Btn
                            disabled={busy || !route.financierId || route.note.trim().length < 3}
                            onClick={() => run("Routed to the next financier", { action: "route_financier", version: c.version, ...route })}
                        >
                            Route
                        </Btn>
                    </div>
                )}

                {can("return") && c.owner === "ECOFY" && <ReturnRow {...p} busy={busy} run={run} />}
                {can("close") && <CloseRow {...p} busy={busy} run={run} />}

                {can("reopen") && (
                    <div className="grid gap-2 border-t border-gray-100 pt-3 sm:grid-cols-[1fr_auto] sm:items-end">
                        <Field label="Reopen reason" hint="Reopens at S0 with Ecofy. Not possible once a File exists.">
                            <input className={inputCls} value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
                        </Field>
                        <Btn disabled={busy || reopenReason.trim().length < 3} onClick={() => run("Lead reopened", { action: "reopen", version: c.version, reason: reopenReason })}>
                            Reopen
                        </Btn>
                    </div>
                )}
            </div>
        </Panel>
    );
}

type RunFn = (label: string, body: Record<string, unknown>) => Promise<unknown>;

function ReturnRow(p: TabProps & { busy: boolean; run: RunFn }) {
    const reasons = useLookup<ListItem>("return_reason");
    const options = reasons.data?.length ? reasons.data : ECOFY_RETURN_REASONS.map((code) => ({ code, label: code.replace(/_/g, " ") }));
    const [code, setCode] = useState("");
    const [note, setNote] = useState("");
    return (
        <div className="grid gap-2 border-t border-gray-100 pt-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Return to Ecofy — reason">
                <select className={inputCls} value={code} onChange={(e) => setCode(e.target.value)}>
                    <option value="">—</option>
                    {options.map((r) => (
                        <option key={r.code} value={r.code}>
                            {r.label}
                        </option>
                    ))}
                </select>
            </Field>
            <Field label="Note">
                <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Btn
                variant="danger"
                disabled={p.busy || !code}
                onClick={() => p.run("Returned to Ecofy", { action: "return", version: p.c.version, reasonCode: code, note: note || undefined })}
            >
                Return
            </Btn>
        </div>
    );
}

function CloseRow(p: TabProps & { busy: boolean; run: RunFn }) {
    const reasons = useLookup<ListItem>("closure_reason");
    const options = reasons.data?.length ? reasons.data : ECOFY_CLOSURE_REASONS.map((code) => ({ code, label: code.replace(/_/g, " ") }));
    const [code, setCode] = useState("");
    const [note, setNote] = useState("");
    return (
        <div className="grid gap-2 border-t border-gray-100 pt-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Close with reason">
                <select className={inputCls} value={code} onChange={(e) => setCode(e.target.value)}>
                    <option value="">—</option>
                    {options.map((r) => (
                        <option key={r.code} value={r.code}>
                            {r.label}
                        </option>
                    ))}
                </select>
            </Field>
            <Field label="Note">
                <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Btn
                variant="danger"
                disabled={p.busy || !code}
                onClick={() => p.run("Lead closed", { action: "close", version: p.c.version, closureReason: code, note: note || undefined })}
            >
                Close lead
            </Btn>
        </div>
    );
}
