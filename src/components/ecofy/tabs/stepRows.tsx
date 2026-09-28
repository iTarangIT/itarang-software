"use client";

// Small stage-transition rows shared by the CurrentStepCard: advance, route to
// the next financier, return to Ecofy, close, reopen. Each renders nothing when
// the viewer may not do it at the lead's stage (useCan), and Ecofy re-checks.

import { useState } from "react";
import { ECOFY_CLOSURE_REASONS, ECOFY_RETURN_REASONS } from "@/lib/ecofy/access";
import { useLookup, type Financier, type ListItem } from "../client";
import { Btn, Field, inputCls } from "../ui";
import { useCan, useRunner, type TabProps } from "./shared";

const rowCls = "grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end";

/** S2 → S3. */
export function AdvanceButton(p: TabProps) {
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    if (!can("advance")) return null;
    return (
        <Btn variant="primary" disabled={busy} onClick={() => run("Moved to assessment (S3)", { action: "advance", version: p.c.version })}>
            Advance to assessment →
        </Btn>
    );
}

/** S4 NOT_ELIGIBLE / S6 REJECTED_ROUTING → next financier (Sales Head). */
export function RouteFinancierRow(p: TabProps) {
    const { c } = p;
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const financiers = useLookup<Financier>("financiers", can("route_financier"));
    const [route, setRoute] = useState({ financierId: "", note: "" });
    if (!can("route_financier")) return null;
    return (
        <div className={rowCls}>
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
            <Field label="Note (mandatory)">
                <input className={inputCls} value={route.note} onChange={(e) => setRoute((r) => ({ ...r, note: e.target.value }))} />
            </Field>
            <Btn
                disabled={busy || !route.financierId || route.note.trim().length < 3}
                onClick={() => run("Routed to the next financier", { action: "route_financier", version: c.version, ...route })}
            >
                Route
            </Btn>
        </div>
    );
}

/** S1–S2, Ecofy-sourced leads only: back to Ecofy's qualifier with a reason (Sales Head). */
export function ReturnRow(p: TabProps) {
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const reasons = useLookup<ListItem>("return_reason", can("return"));
    const [code, setCode] = useState("");
    const [note, setNote] = useState("");
    if (!can("return") || p.c.owner !== "ECOFY") return null;
    const options = reasons.data?.length ? reasons.data : ECOFY_RETURN_REASONS.map((c) => ({ code: c, label: c.replace(/_/g, " ") }));
    return (
        <div className={rowCls}>
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
            <Btn variant="danger" disabled={busy || !code} onClick={() => run("Returned to Ecofy", { action: "return", version: p.c.version, reasonCode: code, note: note || undefined })}>
                Return
            </Btn>
        </div>
    );
}

/** S1–S4: close with a reason. */
export function CloseRow(p: TabProps) {
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const reasons = useLookup<ListItem>("closure_reason", can("close"));
    const [code, setCode] = useState("");
    const [note, setNote] = useState("");
    if (!can("close")) return null;
    const options = reasons.data?.length ? reasons.data : ECOFY_CLOSURE_REASONS.map((c) => ({ code: c, label: c.replace(/_/g, " ") }));
    return (
        <div className={rowCls}>
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
            <Btn variant="danger" disabled={busy || !code} onClick={() => run("Lead closed", { action: "close", version: p.c.version, closureReason: code, note: note || undefined })}>
                Close lead
            </Btn>
        </div>
    );
}

/** CLOSED → S0 with Ecofy (Sales Head). Not possible once a File exists — Ecofy refuses. */
export function ReopenRow(p: TabProps) {
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const [reason, setReason] = useState("");
    if (!can("reopen")) return null;
    return (
        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Reopen reason" hint="Reopens at S0 with Ecofy. Not possible once a File exists.">
                <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Btn disabled={busy || reason.trim().length < 3} onClick={() => run("Lead reopened", { action: "reopen", version: p.c.version, reason })}>
                Reopen
            </Btn>
        </div>
    );
}
