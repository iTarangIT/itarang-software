"use client";

// Financing (S6–S7), Installation, Documents and Withdrawal. The forms are
// exported on their own so the CurrentStepCard can show the one the lead needs
// next (decision, down payment, disbursement, installation, proof uploads).
// Assignment history lives in the Timeline tab (FollowUpTabs).

import { useRef, useState } from "react";
import { formatIst, inr } from "../badges";
import { ecofyGet, ecofyUpload, todayIso, useLeadData, useLookup, type ListItem } from "../client";
import { EpcPartnerPicker } from "../EpcPartnerPicker";
import { Btn, Chip, Empty, ErrorNote, Field, FormBox, inputCls, KV, Loading, Panel } from "../ui";
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

/** The forward milestones in order. STOPPED is the off-ramp, handled separately. */
const MILESTONES = ["SCHEDULED", "IN_PROGRESS", "INSTALLED", "COMMISSIONED"] as const;
type Milestone = (typeof MILESTONES)[number];
const MILESTONE_LABEL: Record<Milestone, string> = {
    SCHEDULED: "Scheduled",
    IN_PROGRESS: "In progress",
    INSTALLED: "Installed",
    COMMISSIONED: "Commissioned",
};

/**
 * Move the installation to its next status — one click, no dropdown. The
 * milestone rail pre-selects the natural next step (a further reachable step
 * can be clicked to skip ahead, e.g. NOT_STARTED → IN_PROGRESS); the date
 * defaults to today and the note stays collapsed until wanted. "Stop
 * installation" is a quiet off-ramp that reveals the mandatory reason.
 * Renders nothing when not allowed or nothing is next.
 */
export function InstallationUpdateForm(p: TabProps & { inst: NonNullable<Installation> }) {
    const { c, inst } = p;
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const allowed = NEXT[inst.status] ?? [];
    const forward = allowed.filter((x) => x !== "STOPPED");
    // Selection falls back to the natural next step whenever the record moves on
    // (the component stays mounted across updates, so the old pick would go stale).
    const [picked, setTarget] = useState<string>("");
    const target = forward.includes(picked) ? picked : (forward[0] ?? "");
    const [stopping, setStopping] = useState(false);
    const [onDate, setOnDate] = useState(todayIso());
    const [note, setNote] = useState("");
    const [showNote, setShowNote] = useState(false);
    const [stopReason, setStopReason] = useState("");
    const [ack, setAck] = useState(false);
    if (!can("update_installation") || allowed.length === 0) return null;

    const status = stopping ? "STOPPED" : target;
    const curIdx = MILESTONES.indexOf(inst.status as Milestone);
    const needsAck = (status === "IN_PROGRESS" || status === "INSTALLED") && c.stage === "S6";
    const canSubmit = !busy && !!status && (!stopping || stopReason.trim().length >= 3) && (!needsAck || ack);
    const label = (m: string) => MILESTONE_LABEL[m as Milestone] ?? pretty(m);
    const submit = () =>
        run(`Installation ${pretty(status)}`, {
            action: "update_installation",
            installationId: inst.id,
            status,
            onDate: onDate || undefined,
            note: note || undefined,
            stopReason: stopping ? stopReason : undefined,
            acknowledgeNoSanction: ack || undefined,
        });

    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                if (canSubmit) void submit();
            }}
            className="mb-4 space-y-3 rounded-lg bg-gray-50 p-3"
        >
            {/* Milestone rail — done ✓, selected next step highlighted, other reachable steps clickable. */}
            <ol className="grid grid-cols-4 gap-1">
                {MILESTONES.map((m, i) => {
                    const done = i <= curIdx;
                    const reachable = forward.includes(m);
                    const selected = !stopping && target === m;
                    const isNext = forward[0] === m;
                    const nodeCls = done
                        ? "bg-gray-900 text-white"
                        : selected
                          ? "bg-[image:var(--gradient-primary)] text-white ring-4 ring-brand-200/70 shadow-md shadow-brand-300/50"
                          : reachable
                            ? "border-2 border-dashed border-brand-400 bg-white text-brand-700 hover:bg-brand-50"
                            : "border border-gray-300 bg-white text-gray-400";
                    return (
                        <li key={m} className="relative flex flex-col items-center text-center">
                            {i > 0 && (
                                <span
                                    aria-hidden
                                    className={`absolute left-0 right-1/2 top-3.5 z-0 border-t-2 ${
                                        done ? "border-gray-900" : selected ? "border-brand-400" : "border-dashed border-gray-300"
                                    }`}
                                />
                            )}
                            {i < MILESTONES.length - 1 && (
                                <span
                                    aria-hidden
                                    className={`absolute left-1/2 right-0 top-3.5 z-0 border-t-2 ${i < curIdx ? "border-gray-900" : "border-dashed border-gray-300"}`}
                                />
                            )}
                            <button
                                type="button"
                                disabled={!reachable}
                                onClick={() => {
                                    setStopping(false);
                                    setTarget(m);
                                }}
                                title={reachable ? (isNext ? "Next step" : "Skip ahead to this step") : undefined}
                                className={`relative z-[1] flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition disabled:cursor-default ${nodeCls}`}
                            >
                                {done ? "✓" : i + 1}
                            </button>
                            <span className={`mt-1 text-[11px] ${done || selected ? "font-semibold text-gray-900" : "text-gray-500"}`}>{MILESTONE_LABEL[m]}</span>
                            {selected && <span className="mt-0.5 text-[10px] font-medium text-brand-700">{isNext ? "next" : "skip to"}</span>}
                        </li>
                    );
                })}
            </ol>

            {/* One-click action row: big button + date; note and stop are tucked away. */}
            <div className="flex flex-wrap items-end gap-2">
                <button
                    type="submit"
                    disabled={!canSubmit}
                    className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50 ${
                        stopping ? "bg-red-600 hover:bg-red-700" : "bg-[image:var(--gradient-primary)] hover:brightness-110"
                    }`}
                >
                    {stopping ? "Stop installation" : `Mark ${status ? label(status) : "—"}`}
                    {!stopping && <span aria-hidden>→</span>}
                </button>
                <label className="flex items-center gap-1.5 text-xs text-gray-600">
                    on
                    <input type="date" className={`${inputCls} !w-auto`} value={onDate} onChange={(e) => setOnDate(e.target.value)} />
                </label>
                {!showNote && (
                    <button type="button" onClick={() => setShowNote(true)} className="text-xs text-gray-500 underline-offset-2 hover:underline">
                        + note
                    </button>
                )}
                <span className="grow" />
                {!stopping ? (
                    <button type="button" onClick={() => setStopping(true)} className="text-xs text-red-600 underline-offset-2 hover:underline">
                        Stop installation…
                    </button>
                ) : (
                    <button type="button" onClick={() => setStopping(false)} className="text-xs text-gray-500 underline-offset-2 hover:underline">
                        Cancel stop
                    </button>
                )}
            </div>

            {showNote && (
                <Field label="Note (optional)" wide>
                    <input autoFocus className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
            )}
            {stopping && (
                <Field label="Stop reason (mandatory)" wide>
                    <input autoFocus required minLength={3} className={inputCls} value={stopReason} onChange={(e) => setStopReason(e.target.value)} />
                </Field>
            )}
            {needsAck && (
                <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
                    No sanction is recorded yet. I acknowledge that installation starts before sanction (audited).
                </label>
            )}
        </form>
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

/** Icon + tint by file kind, so a row is recognisable without reading the name. */
function fileKind(name: string): { icon: string; cls: string; kind: "pdf" | "image" | "audio" | "file" } {
    const ext = name.toLowerCase().split(".").pop() ?? "";
    if (ext === "pdf") return { icon: "PDF", cls: "bg-red-50 text-red-700 ring-red-100", kind: "pdf" };
    if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return { icon: "IMG", cls: "bg-sky-50 text-sky-700 ring-sky-100", kind: "image" };
    if (["mp3", "m4a", "wav", "ogg"].includes(ext)) return { icon: "REC", cls: "bg-violet-50 text-violet-700 ring-violet-100", kind: "audio" };
    return { icon: ext.slice(0, 3).toUpperCase() || "FILE", cls: "bg-gray-100 text-gray-700 ring-gray-200", kind: "file" };
}

const fmtSize = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/**
 * Upload one document to the case, file first: drop a file on the zone (or
 * click to browse), then tap the type it is — that tap uploads. No dropdown,
 * no separate Upload button. With `fixedType` there is no type step at all:
 * choosing the file uploads it (the CurrentStepCard uses this for the S7 proof:
 * INSTALLATION_PHOTO and CUSTOMER_ACCEPTANCE_LETTER). Renders nothing when the
 * viewer may not upload.
 */
export function DocumentUploadRow(p: TabProps & { fixedType?: string; label?: string; hint?: string }) {
    const { leadId } = p;
    const can = useCan(p);
    const { busy, wrap } = useRunner(leadId, p.onDone);
    const types = useLookup<ListItem>("document_type", !p.fixedType);
    const [file, setFile] = useState<File | null>(null);
    const [consent, setConsent] = useState(false);
    const [over, setOver] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    if (!can("upload_document")) return null;

    const options = (types.data ?? []).filter((t) => t.code !== "EPC_QUOTE");
    const isAudio = !!file && fileKind(file.name).kind === "audio";

    async function send(f: File, typeCode: string) {
        const form = new FormData();
        form.set("file", f);
        form.set("kind", "document");
        form.set("typeCode", typeCode);
        if (typeCode === "CALL_RECORDING") form.set("recordingConsent", String(consent));
        const ok = await wrap(`Uploaded ${f.name}`, () => ecofyUpload(`/api/ecofy/leads/${leadId}/documents`, form));
        if (ok) {
            setFile(null);
            setConsent(false);
        }
    }
    function pick(f: File | undefined) {
        if (!f || busy) return;
        if (p.fixedType) void send(f, p.fixedType);
        else setFile(f);
    }

    const zoneLabel = busy
        ? "Uploading…"
        : p.fixedType
          ? `Drop ${(p.label ?? pretty(p.fixedType)).toLowerCase()} here or click to browse`
          : "Drop a file here or click to browse";

    return (
        <div className="space-y-2">
            {/* Step 1 — the file. Click anywhere or drag a file onto it. */}
            <div
                role="button"
                tabIndex={busy ? -1 : 0}
                aria-disabled={busy}
                onClick={() => !busy && inputRef.current?.click()}
                onKeyDown={(e) => {
                    if (!busy && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        inputRef.current?.click();
                    }
                }}
                onDragOver={(e) => {
                    e.preventDefault();
                    if (!busy) setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                    e.preventDefault();
                    setOver(false);
                    pick(e.dataTransfer.files?.[0]);
                }}
                className={`flex items-center gap-3 rounded-lg border-2 border-dashed px-3 py-3 text-sm transition ${
                    busy
                        ? "cursor-wait border-gray-200 bg-white/60 text-gray-400"
                        : over
                          ? "cursor-copy border-brand-500 bg-brand-50 text-brand-800"
                          : file
                            ? "cursor-pointer border-brand-300 bg-brand-50/40 text-gray-800"
                            : "cursor-pointer border-gray-300 bg-white text-gray-700 hover:border-brand-400 hover:bg-brand-50/50"
                }`}
            >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[image:var(--gradient-primary)] text-white shadow-sm" aria-hidden>
                    {busy ? "…" : file ? "✓" : "↑"}
                </span>
                <span className="min-w-0 flex-1">
                    {file && !busy ? (
                        <>
                            <span className="block truncate font-medium">{file.name}</span>
                            <span className="block text-xs text-gray-500">{fmtSize(file.size)} · click to choose a different file</span>
                        </>
                    ) : (
                        <>
                            <span className="block font-medium">{zoneLabel}</span>
                            <span className="block text-xs text-gray-500">{p.hint ?? "PDF, JPG, PNG, MP3, M4A, WAV · up to 25 MB"}</span>
                        </>
                    )}
                </span>
                <input
                    ref={inputRef}
                    type="file"
                    className="sr-only"
                    disabled={busy}
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        pick(f);
                    }}
                />
            </div>

            {/* Step 2 — tap what it is; that tap uploads. Only once a file is chosen. */}
            {file && !p.fixedType && !busy && (
                <div className="rounded-lg bg-gray-50 p-3">
                    <p className="mb-1.5 text-xs font-medium text-gray-700">What is this file? Tap to upload.</p>
                    <div className="flex flex-wrap gap-1.5">
                        {(options.length ? options : [{ code: "SITE_PHOTO", label: "Site photo" }]).map((t) => {
                            const rec = t.code === "CALL_RECORDING";
                            const disabled = rec && !consent;
                            return (
                                <button
                                    key={t.code}
                                    type="button"
                                    disabled={disabled}
                                    title={disabled ? "Tick consent first" : `Upload as ${t.label}`}
                                    onClick={() => void send(file, t.code)}
                                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                                        isAudio === rec
                                            ? "bg-[image:var(--gradient-primary)] text-white shadow-sm shadow-brand-300/50 hover:brightness-110"
                                            : "border border-gray-300 bg-white text-gray-700 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-800"
                                    } disabled:cursor-not-allowed disabled:opacity-40`}
                                >
                                    {t.label} ↑
                                </button>
                            );
                        })}
                    </div>
                    {(isAudio || options.some((t) => t.code === "CALL_RECORDING")) && (
                        <label className="mt-2 flex items-center gap-2 text-xs text-gray-600">
                            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                            Customer consented to recording (needed for call recordings; deleted after 60 days)
                        </label>
                    )}
                    <button type="button" onClick={() => setFile(null)} className="mt-2 text-xs text-gray-500 underline-offset-2 hover:underline">
                        Cancel
                    </button>
                </div>
            )}
        </div>
    );
}

export function DocumentsTab(p: TabProps) {
    const { leadId } = p;
    const can = useCan(p);
    const { busy, run, wrap } = useRunner(leadId, p.onDone);
    const q = useLeadData<Doc[]>(leadId, "documents");
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [reason, setReason] = useState("");

    async function download(id: string) {
        await wrap("Opening document", async () => {
            const r = await ecofyGet<{ url: string }>(`/api/ecofy/documents/${id}/download?leadId=${leadId}`);
            window.open(r.url, "_blank", "noopener");
        });
    }
    async function remove(id: string) {
        if (reason.trim().length < 3) return;
        const ok = await run("Document deleted", { action: "delete_document", documentId: id, reason: reason.trim() });
        if (ok !== undefined) {
            setConfirmId(null);
            setReason("");
        }
    }

    const docs = q.data ?? [];
    return (
        <Panel title="Documents & recordings" right={docs.length ? `${docs.length} file${docs.length === 1 ? "" : "s"} · no KYC types` : "no KYC types"}>
            <div className="mb-4">
                <DocumentUploadRow {...p} />
            </div>
            {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
            {q.data && docs.length === 0 && <Empty>No documents yet — drop the first one above.</Empty>}
            <ul className="space-y-1.5">
                {docs.map((d) => {
                    const k = fileKind(d.fileName);
                    const confirming = confirmId === d.id;
                    return (
                        <li key={d.id} className="group rounded-lg border border-gray-100 bg-white transition hover:border-brand-200 hover:shadow-sm">
                            <div className="flex items-center gap-3 px-3 py-2 text-sm">
                                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[10px] font-bold ring-1 ${k.cls}`} aria-hidden>
                                    {k.icon}
                                </span>
                                <button type="button" onClick={() => download(d.id)} disabled={busy} className="min-w-0 flex-1 text-left" title="Open">
                                    <span className="block truncate font-medium text-gray-900 group-hover:text-brand-700">{d.fileName}</span>
                                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-500">
                                        <span className="rounded bg-gray-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-gray-600">{pretty(d.typeCode)}</span>
                                        <span>{fmtSize(d.sizeBytes)}</span>
                                        <span>·</span>
                                        <span>{formatIst(d.uploadedAt)}</span>
                                        {d.retentionUntil && <span className="text-amber-700">· purge {d.retentionUntil}</span>}
                                    </span>
                                </button>
                                <div className="flex shrink-0 items-center gap-1">
                                    <button
                                        type="button"
                                        onClick={() => download(d.id)}
                                        disabled={busy}
                                        className="rounded-md px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50"
                                    >
                                        Open
                                    </button>
                                    {can("delete_document") && !confirming && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setConfirmId(d.id);
                                                setReason("");
                                            }}
                                            disabled={busy}
                                            className="rounded-md px-2.5 py-1 text-xs font-medium text-gray-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                                        >
                                            Delete
                                        </button>
                                    )}
                                </div>
                            </div>
                            {confirming && (
                                <form
                                    onSubmit={(e) => {
                                        e.preventDefault();
                                        void remove(d.id);
                                    }}
                                    className="flex flex-wrap items-center gap-2 border-t border-red-100 bg-red-50/60 px-3 py-2"
                                >
                                    <input
                                        autoFocus
                                        required
                                        minLength={3}
                                        placeholder="Reason for deleting (required)"
                                        className={`${inputCls} min-w-0 flex-1`}
                                        value={reason}
                                        onChange={(e) => setReason(e.target.value)}
                                    />
                                    <Btn type="submit" variant="danger" disabled={busy || reason.trim().length < 3}>
                                        Delete file
                                    </Btn>
                                    <Btn onClick={() => setConfirmId(null)} disabled={busy}>
                                        Cancel
                                    </Btn>
                                </form>
                            )}
                        </li>
                    );
                })}
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
