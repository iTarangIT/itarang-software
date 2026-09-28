"use client";

// Financing (S6–S7), Installation, Documents and Withdrawal. The forms are
// exported on their own so the CurrentStepCard can show the one the lead needs
// next (decision, down payment, disbursement, installation, proof uploads).
// Assignment history lives in the Timeline tab (FollowUpTabs).

import { useState } from "react";
import { formatIst, inr } from "../badges";
import { ecofyGet, ecofyUpload, todayIso, useLeadData, useLookup, type ListItem } from "../client";
import { EpcPartnerPicker } from "../EpcPartnerPicker";
import { Btn, Chip, Empty, ErrorNote, Field, FormBox, inputCls, KV, Loading, Panel, fileInputCls } from "../ui";
import { pretty, useCan, useRunner, type TabProps } from "./shared";

// ---------------------------------------------------------------------------
// Financing
// ---------------------------------------------------------------------------

export type Decision = {
    id: string;
    attemptNo: number;
    status: string;
    financierName: string | null;
    rejectionReason: string | null;
    submittedAt: string;
    decidedAt: string | null;
    values?: { sanctionedInr: number; downPaymentInr: number | null; tenureMonths: number | null; emiInr: number | null; lenderFileNo: string | null };
};
type DownPayment = { id: string; receivedOn: string; amountInr: number; reference: string | null };
export type PaymentStatus = { downPaymentRecorded: boolean; disbursementRecorded: boolean };

export const isOpenDecision = (d: Decision) => d.status === "SUBMITTED";

/** Record the financier's sanction / rejection (Sales Head). Renders nothing when not allowed. */
export function FinancingDecisionForm(p: TabProps) {
    const { c } = p;
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const [f, setF] = useState({ status: "SANCTIONED", sanctionedInr: "", downPaymentInr: "", tenureMonths: "", emiInr: "", lenderFileNo: "", rejectionReason: "" });
    const num = (v: string) => (v ? Number(v) : undefined);
    if (!can("financing_decision")) return null;

    return (
        <FormBox
            onSubmit={() =>
                run(f.status === "SANCTIONED" ? "Sanction recorded" : "Rejection recorded", {
                    action: "financing_decision",
                    version: c.version,
                    status: f.status,
                    sanctionedInr: num(f.sanctionedInr),
                    downPaymentInr: num(f.downPaymentInr),
                    tenureMonths: num(f.tenureMonths),
                    emiInr: num(f.emiInr),
                    lenderFileNo: f.lenderFileNo || undefined,
                    rejectionReason: f.rejectionReason || undefined,
                })
            }
        >
            <Field label="Decision">
                <select className={inputCls} value={f.status} onChange={(e) => setF((x) => ({ ...x, status: e.target.value }))}>
                    <option value="SANCTIONED">Sanctioned</option>
                    <option value="REJECTED">Rejected</option>
                </select>
            </Field>
            {f.status === "SANCTIONED" ? (
                <>
                    <Field label="Sanctioned amount (₹)" hint="Below the accepted total → re-acceptance OTP in Ecofy">
                        <input type="number" min={1} required className={inputCls} value={f.sanctionedInr} onChange={(e) => setF((x) => ({ ...x, sanctionedInr: e.target.value }))} />
                    </Field>
                    <Field label="Down payment (₹)">
                        <input type="number" min={0} className={inputCls} value={f.downPaymentInr} onChange={(e) => setF((x) => ({ ...x, downPaymentInr: e.target.value }))} />
                    </Field>
                    <Field label="Tenure (months)">
                        <input type="number" min={1} max={120} className={inputCls} value={f.tenureMonths} onChange={(e) => setF((x) => ({ ...x, tenureMonths: e.target.value }))} />
                    </Field>
                    <Field label="EMI from lender (₹)">
                        <input type="number" min={0} className={inputCls} value={f.emiInr} onChange={(e) => setF((x) => ({ ...x, emiInr: e.target.value }))} />
                    </Field>
                    <Field label="Lender file no.">
                        <input className={inputCls} value={f.lenderFileNo} onChange={(e) => setF((x) => ({ ...x, lenderFileNo: e.target.value }))} />
                    </Field>
                </>
            ) : (
                <Field label="Rejection reason (mandatory)" wide>
                    <input required minLength={3} className={inputCls} value={f.rejectionReason} onChange={(e) => setF((x) => ({ ...x, rejectionReason: e.target.value }))} />
                </Field>
            )}
            <div className="flex justify-end sm:col-span-2">
                <Btn type="submit" variant="success" disabled={busy}>
                    Record decision
                </Btn>
            </div>
        </FormBox>
    );
}

/** Record a down payment (Sales Head). Renders nothing when not allowed. */
export function DownPaymentForm(p: TabProps) {
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const [dp, setDp] = useState({ receivedOn: todayIso(), amountInr: "", reference: "" });
    if (!can("down_payment")) return null;
    return (
        <FormBox
            onSubmit={() =>
                run("Down payment recorded", {
                    action: "down_payment",
                    receivedOn: dp.receivedOn,
                    amountInr: Number(dp.amountInr),
                    reference: dp.reference || undefined,
                })
            }
        >
            <Field label="Down payment received on">
                <input type="date" className={inputCls} value={dp.receivedOn} onChange={(e) => setDp((x) => ({ ...x, receivedOn: e.target.value }))} />
            </Field>
            <Field label="Amount (₹)">
                <input type="number" min={1} required className={inputCls} value={dp.amountInr} onChange={(e) => setDp((x) => ({ ...x, amountInr: e.target.value }))} />
            </Field>
            <Field label="Reference" wide>
                <input className={inputCls} value={dp.reference} onChange={(e) => setDp((x) => ({ ...x, reference: e.target.value }))} />
            </Field>
            <div className="flex justify-end sm:col-span-2">
                <Btn type="submit" variant="success" disabled={busy}>
                    Record down payment
                </Btn>
            </div>
        </FormBox>
    );
}

/** Record the disbursement → S8 (Sales Head). Renders nothing when not allowed. */
export function DisbursementForm(p: TabProps) {
    const { c } = p;
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const [disb, setDisb] = useState({ disbursedOn: todayIso(), amountInr: "", reference: "" });
    if (!can("disbursement")) return null;
    return (
        <FormBox
            onSubmit={() =>
                run("Disbursement recorded — asset active (S8)", {
                    action: "disbursement",
                    version: c.version,
                    disbursedOn: disb.disbursedOn,
                    amountInr: Number(disb.amountInr),
                    reference: disb.reference || undefined,
                })
            }
        >
            <Field label="Disbursed on">
                <input type="date" className={inputCls} value={disb.disbursedOn} onChange={(e) => setDisb((x) => ({ ...x, disbursedOn: e.target.value }))} />
            </Field>
            <Field label="Amount (₹)">
                <input type="number" min={1} required className={inputCls} value={disb.amountInr} onChange={(e) => setDisb((x) => ({ ...x, amountInr: e.target.value }))} />
            </Field>
            <Field label="Reference" wide hint="Gate: sanction recorded, installation INSTALLED with photos and the acceptance letter.">
                <input className={inputCls} value={disb.reference} onChange={(e) => setDisb((x) => ({ ...x, reference: e.target.value }))} />
            </Field>
            <div className="flex justify-end sm:col-span-2">
                <Btn type="submit" variant="success" disabled={busy}>
                    Record disbursement → S8
                </Btn>
            </div>
        </FormBox>
    );
}

export function FinancingTab(p: TabProps) {
    const { c, leadId } = p;
    const can = useCan(p);
    const decisions = useLeadData<Decision[]>(leadId, "decisions");
    const status = useLeadData<PaymentStatus>(leadId, "payment-status");
    const dps = useLeadData<DownPayment[]>(leadId, "down-payment", can("down_payment"));
    const open = decisions.data?.find(isOpenDecision);

    return (
        <div className="space-y-4">
            <Panel title="Financing decisions" right={c.financierName ? `financier: ${c.financierName}` : ""}>
                {decisions.isLoading ? <Loading /> : decisions.error ? <ErrorNote error={decisions.error} /> : null}
                {decisions.data && decisions.data.length === 0 && <Empty>No File yet — financing starts when the customer accepts the offer.</Empty>}
                <div className="space-y-2">
                    {(decisions.data ?? []).map((d) => (
                        <div key={d.id} className="rounded-lg border border-gray-200 p-3 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                                <b>Attempt {d.attemptNo}</b> · {d.financierName}
                                <Chip tone={d.status === "SANCTIONED" ? "green" : d.status === "REJECTED" ? "red" : "amber"}>{d.status}</Chip>
                                <span className="ml-auto text-xs text-gray-500">{formatIst(d.decidedAt ?? d.submittedAt)}</span>
                            </div>
                            {d.rejectionReason && <div className="mt-1 text-red-700">Reason: {d.rejectionReason}</div>}
                            {d.values ? (
                                <div className="mt-2">
                                    <KV
                                        rows={[
                                            ["Sanctioned", <b key="s">{inr(d.values.sanctionedInr)}</b>],
                                            ["Down payment", inr(d.values.downPaymentInr)],
                                            ["Tenure", d.values.tenureMonths ? `${d.values.tenureMonths} months` : null],
                                            ["EMI (lender)", inr(d.values.emiInr)],
                                            ["Lender file no.", d.values.lenderFileNo],
                                        ]}
                                    />
                                </div>
                            ) : d.status === "SANCTIONED" ? (
                                <div className="mt-1 text-xs text-gray-500">Amounts are visible only to the financier&apos;s role.</div>
                            ) : null}
                        </div>
                    ))}
                </div>
                {open && <FinancingDecisionForm {...p} />}
            </Panel>

            <Panel
                title="Down payment & disbursement"
                right={
                    status.data
                        ? `down payment ${status.data.downPaymentRecorded ? "recorded" : "not recorded"} · disbursement ${status.data.disbursementRecorded ? "recorded" : "not recorded"}`
                        : ""
                }
            >
                {(dps.data ?? []).length > 0 && (
                    <ul className="mb-3 space-y-1 text-sm">
                        {dps.data!.map((d) => (
                            <li key={d.id}>
                                Down payment received {d.receivedOn}: <b>{inr(d.amountInr)}</b> {d.reference ? `· ${d.reference}` : ""}
                            </li>
                        ))}
                    </ul>
                )}
                {!can("down_payment") && !can("disbursement") && (
                    <p className="text-sm text-gray-500">Payments are recorded by the Sales Head (or by Ecofy for its own financing).</p>
                )}
                {!status.data?.downPaymentRecorded && <DownPaymentForm {...p} />}
                <DisbursementForm {...p} />
            </Panel>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export type Installation = {
    id: string;
    status: string;
    epcPartnerName: string | null;
    scheduledOn: string | null;
    startedOn: string | null;
    completedOn: string | null;
    startedBeforeSanction: boolean;
    stopReason: string | null;
    events: Array<{ id: number; status: string; note: string | null; at: string }>;
} | null;

const NEXT: Record<string, string[]> = {
    NOT_STARTED: ["SCHEDULED", "IN_PROGRESS", "STOPPED"],
    SCHEDULED: ["IN_PROGRESS", "STOPPED"],
    IN_PROGRESS: ["INSTALLED", "STOPPED"],
    INSTALLED: ["COMMISSIONED", "STOPPED"],
    COMMISSIONED: [],
    STOPPED: [],
};

/** Pick the EPC partner and create the installation record. Renders nothing when not allowed. */
export function CreateInstallationRow(p: TabProps) {
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const [epc, setEpc] = useState("");
    const [scheduledOn, setScheduledOn] = useState("");
    if (!can("create_installation")) return null;
    return (
        <div className="grid grid-cols-1 items-end gap-2 rounded-lg bg-gray-50 p-3 sm:grid-cols-2">
            <EpcPartnerPicker value={epc} onChange={setEpc} />
            <Field label="Scheduled on (optional)">
                <input type="date" className={inputCls} value={scheduledOn} onChange={(e) => setScheduledOn(e.target.value)} />
            </Field>
            <Btn variant="primary" disabled={busy || !epc} onClick={() => run("Installation created", { action: "create_installation", epcPartnerId: epc, scheduledOn: scheduledOn || undefined })}>
                Create installation
            </Btn>
        </div>
    );
}

/** Move the installation to its next status. Renders nothing when not allowed or nothing is next. */
export function InstallationUpdateForm(p: TabProps & { inst: NonNullable<Installation> }) {
    const { c, inst } = p;
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const [u, setU] = useState({ status: "", onDate: todayIso(), note: "", stopReason: "", ack: false });
    if (!can("update_installation") || (NEXT[inst.status]?.length ?? 0) === 0) return null;
    return (
        <FormBox
            onSubmit={() =>
                run(`Installation ${pretty(u.status)}`, {
                    action: "update_installation",
                    installationId: inst.id,
                    status: u.status,
                    onDate: u.onDate || undefined,
                    note: u.note || undefined,
                    stopReason: u.status === "STOPPED" ? u.stopReason : undefined,
                    acknowledgeNoSanction: u.ack || undefined,
                })
            }
        >
            <Field label="New status">
                <select required className={inputCls} value={u.status} onChange={(e) => setU((x) => ({ ...x, status: e.target.value }))}>
                    <option value="">—</option>
                    {NEXT[inst.status].map((s) => (
                        <option key={s} value={s}>
                            {pretty(s)}
                        </option>
                    ))}
                </select>
            </Field>
            <Field label="Date">
                <input type="date" className={inputCls} value={u.onDate} onChange={(e) => setU((x) => ({ ...x, onDate: e.target.value }))} />
            </Field>
            <Field label="Note" wide>
                <input className={inputCls} value={u.note} onChange={(e) => setU((x) => ({ ...x, note: e.target.value }))} />
            </Field>
            {u.status === "STOPPED" && (
                <Field label="Stop reason (mandatory)" wide>
                    <input required minLength={3} className={inputCls} value={u.stopReason} onChange={(e) => setU((x) => ({ ...x, stopReason: e.target.value }))} />
                </Field>
            )}
            {(u.status === "IN_PROGRESS" || u.status === "INSTALLED") && c.stage === "S6" && (
                <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 sm:col-span-2">
                    <input type="checkbox" checked={u.ack} onChange={(e) => setU((x) => ({ ...x, ack: e.target.checked }))} className="mt-0.5" />
                    No sanction is recorded yet. I acknowledge that installation starts before sanction (audited).
                </label>
            )}
            <div className="flex justify-end sm:col-span-2">
                <Btn type="submit" variant="primary" disabled={busy || !u.status}>
                    Update
                </Btn>
            </div>
        </FormBox>
    );
}

/** The installation record: partner, dates, event log. */
export function InstallationSummary({ inst }: { inst: NonNullable<Installation> }) {
    return (
        <div className="space-y-3 text-sm">
            {inst.startedBeforeSanction && <p className="rounded-lg bg-amber-50 p-2 text-amber-800">Started before sanction (acknowledged and audited).</p>}
            <KV
                rows={[
                    ["EPC partner", inst.epcPartnerName],
                    ["Scheduled", inst.scheduledOn],
                    ["Started", inst.startedOn],
                    ["Completed", inst.completedOn],
                    ...(inst.stopReason ? ([["Stopped", inst.stopReason]] as Array<[string, string]>) : []),
                ]}
            />
            <ol className="space-y-1">
                {inst.events.map((e) => (
                    <li key={e.id} className="text-xs">
                        <span className="text-gray-500">{formatIst(e.at)}</span> — <b>{e.status}</b> {e.note ? `· ${e.note}` : ""}
                    </li>
                ))}
            </ol>
        </div>
    );
}

export function InstallationTab(p: TabProps) {
    const can = useCan(p);
    const q = useLeadData<Installation>(p.leadId, "installation");
    const inst = q.data ?? null;

    return (
        <Panel title="Installation (EPC executes)" right={inst ? `status ${inst.status}` : ""}>
            {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
            {!q.isLoading && !inst && !can("create_installation") && <Empty>No installation yet — it is created after the File (S6).</Empty>}
            {!inst && <CreateInstallationRow {...p} />}
            {inst && (
                <div className="space-y-3">
                    <InstallationSummary inst={inst} />
                    <InstallationUpdateForm {...p} inst={inst} />
                </div>
            )}
        </Panel>
    );
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type Doc = { id: string; typeCode: string; fileName: string; sizeBytes: number; uploadedAt: string; retentionUntil: string | null };

/**
 * Upload one document to the case. With `fixedType` the type picker is hidden
 * (the CurrentStepCard uses this for the S7 proof: INSTALLATION_PHOTO and
 * CUSTOMER_ACCEPTANCE_LETTER). Renders nothing when the viewer may not upload.
 */
export function DocumentUploadRow(p: TabProps & { fixedType?: string; label?: string; hint?: string }) {
    const { leadId } = p;
    const can = useCan(p);
    const { busy, wrap } = useRunner(leadId, p.onDone);
    const types = useLookup<ListItem>("document_type", !p.fixedType);
    const [typeCode, setTypeCode] = useState(p.fixedType ?? "SITE_PHOTO");
    const [consent, setConsent] = useState(false);
    if (!can("upload_document")) return null;

    async function upload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        const form = new FormData();
        form.set("file", file);
        form.set("kind", "document");
        form.set("typeCode", typeCode);
        if (typeCode === "CALL_RECORDING") form.set("recordingConsent", String(consent));
        await wrap("Uploaded to Ecofy", () => ecofyUpload(`/api/ecofy/leads/${leadId}/documents`, form));
    }

    return (
        <div className={`grid grid-cols-1 items-start gap-3 rounded-lg bg-gray-50 p-3 ${p.fixedType ? "" : "sm:grid-cols-2"}`}>
            {!p.fixedType && (
                <Field label="Type">
                    <select className={inputCls} value={typeCode} onChange={(e) => setTypeCode(e.target.value)}>
                        {(types.data ?? [])
                            .filter((t) => t.code !== "EPC_QUOTE")
                            .map((t) => (
                                <option key={t.code} value={t.code}>
                                    {t.label}
                                </option>
                            ))}
                        {!types.data?.length && <option value="SITE_PHOTO">Site photo</option>}
                    </select>
                </Field>
            )}
            <Field label={p.label ?? "File"} hint={p.hint}>
                <input type="file" className={fileInputCls} disabled={busy || (typeCode === "CALL_RECORDING" && !consent)} onChange={upload} />
            </Field>
            {typeCode === "CALL_RECORDING" && (
                <label className="flex items-center gap-1 text-xs sm:col-span-2">
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Customer consented to recording (deleted after 60 days)
                </label>
            )}
        </div>
    );
}

export function DocumentsTab(p: TabProps) {
    const { leadId } = p;
    const can = useCan(p);
    const { busy, run, wrap } = useRunner(leadId, p.onDone);
    const q = useLeadData<Doc[]>(leadId, "documents");

    async function download(id: string) {
        await wrap("Opening document", async () => {
            const r = await ecofyGet<{ url: string }>(`/api/ecofy/documents/${id}/download?leadId=${leadId}`);
            window.open(r.url, "_blank", "noopener");
        });
    }
    async function remove(id: string) {
        const reason = window.prompt("Reason for deleting this document?");
        if (!reason || reason.trim().length < 3) return;
        await run("Document deleted", { action: "delete_document", documentId: id, reason });
    }

    return (
        <Panel title="Documents & recordings" right="PDF, JPG, PNG, MP3, M4A, WAV · 25 MB · no KYC types">
            <div className="mb-4">
                <DocumentUploadRow {...p} />
            </div>
            {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
            {q.data && q.data.length === 0 && <Empty>No documents.</Empty>}
            <ul className="divide-y divide-gray-100">
                {(q.data ?? []).map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                        <Chip>{d.typeCode}</Chip>
                        <span className="min-w-0 flex-1 break-all">
                            {d.fileName}
                            <span className="block text-xs text-gray-500">
                                {(d.sizeBytes / 1024).toFixed(0)} KB · {formatIst(d.uploadedAt)}
                                {d.retentionUntil ? ` · purge ${d.retentionUntil}` : ""}
                            </span>
                        </span>
                        <Btn disabled={busy} onClick={() => download(d.id)}>
                            Download
                        </Btn>
                        {can("delete_document") && (
                            <Btn variant="danger" disabled={busy} onClick={() => remove(d.id)}>
                                Delete
                            </Btn>
                        )}
                    </li>
                ))}
            </ul>
        </Panel>
    );
}

// ---------------------------------------------------------------------------
// Withdrawal
// ---------------------------------------------------------------------------

type Withdrawal = {
    id: string;
    stageAtRequest: string;
    reason: string;
    status: string;
    requestedAt: string;
    confirmedAt: string | null;
    ecofyAlertedAt: string | null;
    sanctionCancelledAt: string | null;
    epcInformedAt: string | null;
};

export function WithdrawalTab(p: TabProps) {
    const { c, leadId } = p;
    const can = useCan(p);
    const { busy, run } = useRunner(leadId, p.onDone);
    const q = useLeadData<Withdrawal[]>(leadId, "withdrawals");
    const [reason, setReason] = useState("");
    const after = ["S5", "S6", "S7"].includes(c.stage);

    return (
        <Panel title="Withdrawal" right="after disbursement Ecofy handles it outside the platform">
            {can("request_withdrawal") && (
                <div className="mb-4 grid gap-2 rounded-lg bg-gray-50 p-3 sm:grid-cols-[1fr_auto] sm:items-end">
                    <Field
                        label="Reason (mandatory)"
                        hint={after ? "After acceptance the Sales Head must confirm; the File is kept and Ecofy is alerted." : "Before acceptance the lead closes at once as WITHDRAWN."}
                    >
                        <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
                    </Field>
                    <Btn variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => run("Withdrawal recorded", { action: "request_withdrawal", reason })}>
                        Request withdrawal
                    </Btn>
                </div>
            )}
            {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
            {q.data && q.data.length === 0 && <Empty>No withdrawal.</Empty>}
            <div className="space-y-2">
                {(q.data ?? []).map((w) => (
                    <div key={w.id} className="rounded-lg border border-gray-200 p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                            <b>At {w.stageAtRequest}</b>
                            <Chip tone={w.status === "CONFIRMED" ? "red" : w.status === "REJECTED" ? "gray" : "amber"}>{w.status}</Chip>
                            <span className="ml-auto text-xs text-gray-500">{formatIst(w.requestedAt)}</span>
                        </div>
                        <div className="mt-1">{w.reason}</div>
                        <div className="mt-1 text-xs text-gray-500">
                            confirmed {formatIst(w.confirmedAt)} · Ecofy alerted {formatIst(w.ecofyAlertedAt)} · sanction cancelled {formatIst(w.sanctionCancelledAt)} · EPC informed{" "}
                            {formatIst(w.epcInformedAt)}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                            {can("withdrawal_confirm") && w.status === "REQUESTED" && (
                                <>
                                    <Btn variant="danger" disabled={busy} onClick={() => run("Withdrawal confirmed — lead closed", { action: "withdrawal_confirm", withdrawalId: w.id })}>
                                        Confirm withdrawal
                                    </Btn>
                                    <Btn
                                        disabled={busy}
                                        onClick={() => {
                                            const r = window.prompt("Reason for rejecting the withdrawal?");
                                            if (r && r.trim().length >= 3) run("Withdrawal rejected", { action: "withdrawal_reject", withdrawalId: w.id, reason: r });
                                        }}
                                    >
                                        Reject
                                    </Btn>
                                </>
                            )}
                            {can("withdrawal_epc_informed") && w.status === "CONFIRMED" && !w.epcInformedAt && (
                                <Btn disabled={busy} onClick={() => run("EPC marked informed", { action: "withdrawal_epc_informed", withdrawalId: w.id })}>
                                    Mark EPC informed
                                </Btn>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </Panel>
    );
}
