"use client";

// Assessment (S3) and Offer (S4–S5): eligibility, EPC quotes, offer, OTP, File.

import { useState } from "react";
import { formatIst, inr } from "../badges";
import { ecofyGet, ecofyUpload, todayIso, useLeadData, useLookup, type EpcPartner, type Financier } from "../client";
import { Btn, Chip, Empty, ErrorNote, Field, FormBox, inputCls, KV, Loading, Panel } from "../ui";
import { pretty, useCan, useRunner, type TabProps } from "./shared";

type Assessment = {
    id: string;
    version: number;
    method: string;
    recommendationStatus: string;
    recommendedCode: string | null;
    selectedCode: string | null;
    overrideReason: string | null;
    confirmedAt: string | null;
    createdAt: string;
    result?: { steps?: Record<string, number | null>; texts?: { message?: string } };
};

export function AssessmentTab(p: TabProps) {
    const q = useLeadData<Assessment[]>(p.leadId, "assessments");
    const can = useCan(p);
    const { busy, run } = useRunner(p.leadId, p.onDone);
    const [f, setF] = useState({ method: "MANUAL", batteryKwh: "", inverterKva: "", solarKwp: "", sourceNote: "" });
    const latest = q.data?.[0];
    const num = (v: string) => (v ? Number(v) : undefined);

    return (
        <div className="space-y-4">
            {can("save_assessment") && (
                <Panel title="New assessment" right={p.c.segment === "CI" ? "C&I: EPC sizing required" : `latest version ${latest?.version ?? 0}`}>
                    <p className="mb-3 text-xs text-gray-500">
                        Record a manual or EPC sizing. The calculator-driven assessment is available in Ecofy itself.
                        No size at all is saved as “pending technical data”.
                    </p>
                    <FormBox
                        onSubmit={() =>
                            run("Assessment saved", {
                                action: "save_assessment",
                                method: f.method,
                                batteryKwh: num(f.batteryKwh),
                                inverterKva: num(f.inverterKva),
                                solarKwp: num(f.solarKwp),
                                sourceNote: f.sourceNote,
                            })
                        }
                    >
                        <Field label="Method">
                            <select className={inputCls} value={f.method} onChange={(e) => setF((x) => ({ ...x, method: e.target.value }))}>
                                <option value="MANUAL">Manual entry</option>
                                <option value="EPC">EPC sizing</option>
                            </select>
                        </Field>
                        <Field label="Battery (kWh)">
                            <input type="number" step="0.1" min={0} className={inputCls} value={f.batteryKwh} onChange={(e) => setF((x) => ({ ...x, batteryKwh: e.target.value }))} />
                        </Field>
                        <Field label="Inverter (kVA)">
                            <input type="number" step="0.1" min={0} className={inputCls} value={f.inverterKva} onChange={(e) => setF((x) => ({ ...x, inverterKva: e.target.value }))} />
                        </Field>
                        <Field label="Solar (kWp)">
                            <input type="number" step="0.1" min={0} className={inputCls} value={f.solarKwp} onChange={(e) => setF((x) => ({ ...x, solarKwp: e.target.value }))} />
                        </Field>
                        <Field label="Source note (EPC site survey, customer load data …)" wide>
                            <input required minLength={3} className={inputCls} value={f.sourceNote} onChange={(e) => setF((x) => ({ ...x, sourceNote: e.target.value }))} />
                        </Field>
                        <div className="flex justify-end sm:col-span-2">
                            <Btn type="submit" variant="primary" disabled={busy || f.sourceNote.trim().length < 3}>
                                Save assessment
                            </Btn>
                        </div>
                    </FormBox>
                </Panel>
            )}
            <Panel title="Assessment versions" right="latest is current">
                {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
                {q.data && q.data.length === 0 && <Empty>No assessment yet. S3 cannot complete without one.</Empty>}
                <div className="space-y-2">
                    {(q.data ?? []).map((a) => (
                        <div key={a.id} className="rounded-lg border border-gray-200 p-3 text-sm">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                                <b>v{a.version}</b>
                                <Chip>{a.method}</Chip>
                                <Chip tone={a.recommendationStatus === "RECOMMENDED" ? "green" : "amber"}>{pretty(a.recommendationStatus)}</Chip>
                                {a.confirmedAt && <Chip tone="dark">confirmed {formatIst(a.confirmedAt)}</Chip>}
                                <span className="ml-auto text-xs text-gray-500">{formatIst(a.createdAt)}</span>
                            </div>
                            <KV
                                rows={[
                                    ["Recommended", a.recommendedCode],
                                    ["Selected", a.selectedCode ? `${a.selectedCode}${a.overrideReason ? ` · override: ${a.overrideReason}` : ""}` : null],
                                    [
                                        "Sizing",
                                        Object.entries(a.result?.steps ?? {})
                                            .filter(([, v]) => v !== null && v !== undefined)
                                            .map(([k, v]) => `${k}=${v}`)
                                            .join(" · ") || null,
                                    ],
                                    ...(a.result?.texts?.message ? ([["Message", a.result.texts.message]] as Array<[string, string]>) : []),
                                ]}
                            />
                            {can("confirm_assessment") && !a.confirmedAt && a.version === latest?.version && (
                                <div className="mt-2">
                                    <Btn
                                        variant="primary"
                                        disabled={busy}
                                        onClick={() => run("Assessment confirmed — at offer stage", { action: "confirm_assessment", version: p.c.version, assessmentId: a.id })}
                                    >
                                        Confirm assessment → S4
                                    </Btn>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </Panel>
        </div>
    );
}

type Quote = {
    id: string;
    version: number;
    status: string;
    provisional: boolean;
    provisionalReason: string | null;
    systemDesc: string;
    equipmentInr: number;
    installationInr: number;
    gstInr: number;
    totalInr: number;
    validUntil: string;
    documentId: string;
};
type Offer = {
    id: string;
    version: number;
    status: string;
    limitCheck: "WITHIN" | "ABOVE" | "UNKNOWN";
    provisional: boolean;
    content: { system: string; equipmentInr: number; installationInr: number; gstInr: number; totalInr: number; financingLine: string; provisionalReason: string | null };
};
type Otp = { challengeId: string; maskedMobile: string; expiresAt: string; attemptsRemaining: number };
type FileRec = { fileNo: string; acceptedTotalInr: number; quoteVersion: number; acceptedAt: string; provisional: boolean } | null;

export function OfferTab(p: TabProps) {
    const { c, leadId } = p;
    const can = useCan(p);
    const { busy, run, wrap } = useRunner(leadId, p.onDone);
    const assessments = useLeadData<Assessment[]>(leadId, "assessments");
    const quotes = useLeadData<Quote[]>(leadId, "quotes");
    const offers = useLeadData<Offer[]>(leadId, "offers");
    const file = useLeadData<FileRec>(leadId, "file");
    const epcs = useLookup<EpcPartner>("epc-partners");
    const financiers = useLookup<Financier>("financiers", can("route_financier"));
    const [financierId, setFinancierId] = useState("");
    const [pdf, setPdf] = useState<File | null>(null);
    const [qr, setQr] = useState({ epcPartnerId: "", channel: "EMAIL" });
    const [qf, setQf] = useState({
        epcPartnerId: "",
        assessmentId: "",
        systemDesc: "",
        batteryKwh: "",
        inverterKva: "",
        solarKwp: "",
        equipmentInr: "",
        installationInr: "",
        gstInr: "",
        validUntil: "",
        notes: "",
        provisional: false,
        provisionalReason: "",
    });
    const [otp, setOtp] = useState<Otp | null>(null);
    const [code, setCode] = useState("");
    const latestAssessment = assessments.data?.[0];
    const pendingData = latestAssessment?.recommendationStatus === "PENDING_TECHNICAL_DATA";
    const active = quotes.data?.find((q) => q.status === "ACTIVE" || q.status === "ACCEPTED");
    const liveOffer = offers.data?.find((o) => ["DRAFT", "SENT", "ACCEPTED"].includes(o.status));
    const num = (v: string) => (v ? Number(v) : undefined);
    const activeEpcs = (epcs.data ?? []).filter((e) => e.active);

    async function uploadQuote() {
        if (!pdf) return;
        const form = new FormData();
        form.set("file", pdf);
        form.set("kind", "quote");
        form.set("idempotencyKey", crypto.randomUUID());
        form.set(
            "quote",
            JSON.stringify({
                assessmentId: qf.assessmentId || latestAssessment?.id,
                epcPartnerId: qf.epcPartnerId,
                systemDesc: qf.systemDesc,
                batteryKwh: num(qf.batteryKwh),
                inverterKva: num(qf.inverterKva),
                solarKwp: num(qf.solarKwp),
                equipmentInr: Number(qf.equipmentInr),
                installationInr: Number(qf.installationInr),
                gstInr: Number(qf.gstInr),
                validUntil: qf.validUntil,
                notes: qf.notes || undefined,
                provisional: qf.provisional || pendingData || undefined,
                provisionalReason: qf.provisional || pendingData ? qf.provisionalReason : undefined,
            }),
        );
        const ok = await wrap("EPC quote uploaded", () => ecofyUpload(`/api/ecofy/leads/${leadId}/documents`, form));
        if (ok) setPdf(null);
    }

    async function download(documentId: string) {
        await wrap("Opening PDF", async () => {
            const r = await ecofyGet<{ url: string }>(`/api/ecofy/documents/${documentId}/download?leadId=${leadId}`);
            window.open(r.url, "_blank", "noopener");
        });
    }

    return (
        <div className="space-y-4">
            <Panel title="Eligibility" right={`sub-status: ${pretty(c.subStatus)}`}>
                <p className="text-sm text-gray-600">
                    The financier decides eligibility. Callers see only whether the quote is <b>within</b> or <b>above</b> the eligible limit, never the amount.
                </p>
                {can("request_eligibility") && (
                    <div className="mt-3 flex flex-wrap items-end gap-2">
                        {can("route_financier") && (
                            <Field label="Financier">
                                <select className={inputCls} value={financierId} onChange={(e) => setFinancierId(e.target.value)}>
                                    <option value="">Current ({c.financierName ?? "default"})</option>
                                    {(financiers.data ?? [])
                                        .filter((f) => f.active)
                                        .map((f) => (
                                            <option key={f.id} value={f.id}>
                                                {f.name}
                                            </option>
                                        ))}
                                </select>
                            </Field>
                        )}
                        <Btn variant="primary" disabled={busy} onClick={() => run("Sent for eligibility", { action: "request_eligibility", financierId: financierId || undefined })}>
                            Send for eligibility
                        </Btn>
                    </div>
                )}
            </Panel>

            <Panel title="EPC quotes" right="the price is the EPC partner's quote">
                {can("quote_request") && (
                    <div className="mb-4 flex flex-wrap items-end gap-2 rounded-lg bg-gray-50 p-3">
                        <Field label="Log a quote request to">
                            <select className={inputCls} value={qr.epcPartnerId} onChange={(e) => setQr((x) => ({ ...x, epcPartnerId: e.target.value }))}>
                                <option value="">EPC partner…</option>
                                {activeEpcs.map((e) => (
                                    <option key={e.id} value={e.id}>
                                        {e.name}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Channel">
                            <select className={inputCls} value={qr.channel} onChange={(e) => setQr((x) => ({ ...x, channel: e.target.value }))}>
                                {["EMAIL", "WHATSAPP", "PHONE"].map((ch) => (
                                    <option key={ch} value={ch}>
                                        {ch.toLowerCase()}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Btn disabled={busy || !qr.epcPartnerId} onClick={() => run("Quote request logged", { action: "quote_request", ...qr })}>
                            Log request
                        </Btn>
                    </div>
                )}
                {can("upload_quote") && (
                    <FormBox onSubmit={uploadQuote}>
                        <Field label="EPC partner">
                            <select required className={inputCls} value={qf.epcPartnerId} onChange={(e) => setQf((x) => ({ ...x, epcPartnerId: e.target.value }))}>
                                <option value="">—</option>
                                {activeEpcs.map((e) => (
                                    <option key={e.id} value={e.id}>
                                        {e.name}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Answers assessment">
                            <select className={inputCls} value={qf.assessmentId || latestAssessment?.id || ""} onChange={(e) => setQf((x) => ({ ...x, assessmentId: e.target.value }))}>
                                {(assessments.data ?? []).map((a) => (
                                    <option key={a.id} value={a.id}>
                                        v{a.version} · {pretty(a.recommendationStatus)}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Quote PDF" wide>
                            <input type="file" accept="application/pdf" className="text-sm" onChange={(e) => setPdf(e.target.files?.[0] ?? null)} />
                        </Field>
                        <Field label="System description" wide>
                            <input required minLength={3} className={inputCls} value={qf.systemDesc} onChange={(e) => setQf((x) => ({ ...x, systemDesc: e.target.value }))} />
                        </Field>
                        <Field label="Battery (kWh)">
                            <input type="number" step="0.1" className={inputCls} value={qf.batteryKwh} onChange={(e) => setQf((x) => ({ ...x, batteryKwh: e.target.value }))} />
                        </Field>
                        <Field label="Inverter (kVA)">
                            <input type="number" step="0.1" className={inputCls} value={qf.inverterKva} onChange={(e) => setQf((x) => ({ ...x, inverterKva: e.target.value }))} />
                        </Field>
                        <Field label="Solar (kWp)">
                            <input type="number" step="0.1" className={inputCls} value={qf.solarKwp} onChange={(e) => setQf((x) => ({ ...x, solarKwp: e.target.value }))} />
                        </Field>
                        <Field label="Equipment (₹)">
                            <input type="number" min={0} required className={inputCls} value={qf.equipmentInr} onChange={(e) => setQf((x) => ({ ...x, equipmentInr: e.target.value }))} />
                        </Field>
                        <Field label="Installation (₹)">
                            <input type="number" min={0} required className={inputCls} value={qf.installationInr} onChange={(e) => setQf((x) => ({ ...x, installationInr: e.target.value }))} />
                        </Field>
                        <Field label="GST (₹)">
                            <input type="number" min={0} required className={inputCls} value={qf.gstInr} onChange={(e) => setQf((x) => ({ ...x, gstInr: e.target.value }))} />
                        </Field>
                        <Field label="Valid until">
                            <input type="date" required min={todayIso()} className={inputCls} value={qf.validUntil} onChange={(e) => setQf((x) => ({ ...x, validUntil: e.target.value }))} />
                        </Field>
                        <Field label="Notes">
                            <input className={inputCls} value={qf.notes} onChange={(e) => setQf((x) => ({ ...x, notes: e.target.value }))} />
                        </Field>
                        <label className="flex items-center gap-2 text-sm sm:col-span-2">
                            <input
                                type="checkbox"
                                checked={qf.provisional || pendingData}
                                disabled={pendingData}
                                onChange={(e) => setQf((x) => ({ ...x, provisional: e.target.checked }))}
                            />
                            Provisional quote {pendingData ? "(required — the assessment is pending technical data)" : ""}
                        </label>
                        {(qf.provisional || pendingData) && (
                            <Field label="Provisional reason (mandatory)" wide>
                                <input required className={inputCls} value={qf.provisionalReason} onChange={(e) => setQf((x) => ({ ...x, provisionalReason: e.target.value }))} />
                            </Field>
                        )}
                        <div className="flex justify-end sm:col-span-2">
                            <Btn type="submit" variant="primary" disabled={busy || !pdf}>
                                Upload quote {active ? `as v${active.version + 1}` : "v1"}
                            </Btn>
                        </div>
                    </FormBox>
                )}
                {quotes.isLoading ? <Loading /> : quotes.error ? <ErrorNote error={quotes.error} /> : null}
                {quotes.data && quotes.data.length === 0 && <Empty>No EPC quote yet.</Empty>}
                <div className="space-y-2">
                    {(quotes.data ?? []).map((q) => (
                        <div key={q.id} className="rounded-lg border border-gray-200 p-3 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                                <b>Quote v{q.version}</b>
                                <Chip tone={q.status === "ACTIVE" ? "sky" : q.status === "ACCEPTED" ? "dark" : "gray"}>{q.status}</Chip>
                                {q.provisional && <Chip tone="amber">Provisional</Chip>}
                                <span className="ml-auto text-xs text-gray-500">valid until {q.validUntil}</span>
                            </div>
                            <div className="mt-1">{q.systemDesc}</div>
                            <div className="mt-1 text-gray-700">
                                equipment {inr(q.equipmentInr)} + installation {inr(q.installationInr)} + GST {inr(q.gstInr)} = <b>{inr(q.totalInr)}</b>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2">
                                <Btn disabled={busy} onClick={() => download(q.documentId)}>
                                    Download PDF
                                </Btn>
                                {can("compose_offer") && q.status === "ACTIVE" && (
                                    <Btn variant="primary" disabled={busy} onClick={() => run("Offer composed", { action: "compose_offer", quoteId: q.id, idempotencyKey: crypto.randomUUID() })}>
                                        Compose offer from v{q.version}
                                    </Btn>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </Panel>

            <Panel title="Offer & customer acceptance (SMS OTP)" right="no EMI in the offer">
                {offers.isLoading ? <Loading /> : offers.error ? <ErrorNote error={offers.error} /> : null}
                {!offers.isLoading && !liveOffer && <Empty>No offer yet. Compose it from the ACTIVE quote.</Empty>}
                {liveOffer && (
                    <div className="space-y-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                            <b>Offer v{liveOffer.version}</b>
                            <Chip>{liveOffer.status}</Chip>
                            <Chip tone={liveOffer.limitCheck === "WITHIN" ? "green" : liveOffer.limitCheck === "ABOVE" ? "amber" : "gray"}>
                                {liveOffer.limitCheck === "WITHIN" ? "within eligible limit" : liveOffer.limitCheck === "ABOVE" ? "above eligible limit" : "eligibility unknown"}
                            </Chip>
                            {liveOffer.provisional && <Chip tone="amber">Provisional</Chip>}
                        </div>
                        <KV
                            rows={[
                                ["System", liveOffer.content.system],
                                ["Equipment", inr(liveOffer.content.equipmentInr)],
                                ["Installation", inr(liveOffer.content.installationInr)],
                                ["GST", inr(liveOffer.content.gstInr)],
                                ["Total", <b key="t">{inr(liveOffer.content.totalInr)}</b>],
                                ["Financing", liveOffer.content.financingLine],
                            ]}
                        />
                        {can("send_otp") && liveOffer.status !== "ACCEPTED" && (
                            <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
                                <Btn
                                    variant="primary"
                                    disabled={busy}
                                    onClick={async () => {
                                        const r = await run<Otp>(c.stage === "S4" ? "OTP sent — at S5" : "OTP re-sent", {
                                            action: "send_otp",
                                            version: c.version,
                                            offerId: liveOffer.id,
                                            idempotencyKey: crypto.randomUUID(),
                                        });
                                        if (r) setOtp(r);
                                    }}
                                >
                                    {c.stage === "S4" ? "Send offer — SMS OTP to customer" : "Resend OTP"}
                                </Btn>
                                {otp && (
                                    <span className="text-xs text-gray-500">
                                        Sent to {otp.maskedMobile}, expires {formatIst(otp.expiresAt)} · {otp.attemptsRemaining} attempts
                                    </span>
                                )}
                            </div>
                        )}
                        {can("verify_otp") && (
                            <div className="flex flex-wrap items-end gap-2">
                                <Field label="Customer's OTP" hint="6 digits · 5 attempts · 10 minutes">
                                    <input
                                        className={`${inputCls} w-40 text-center tracking-[0.3em]`}
                                        maxLength={6}
                                        value={code}
                                        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                                    />
                                </Field>
                                <Btn
                                    variant="success"
                                    disabled={busy || code.length !== 6 || !otp}
                                    onClick={async () => {
                                        const r = await run("Accepted — File locked", { action: "verify_otp", challengeId: otp!.challengeId, code });
                                        if (r !== undefined) setCode("");
                                    }}
                                >
                                    Verify & lock File
                                </Btn>
                                {!otp && <span className="text-xs text-gray-500">Resend the OTP to get a challenge for this screen.</span>}
                            </div>
                        )}
                    </div>
                )}
            </Panel>

            {file.data && (
                <Panel title={`File ${file.data.fileNo}`} right="never edited or deleted">
                    <KV
                        rows={[
                            ["Accepted total", <b key="t">{inr(file.data.acceptedTotalInr)}</b>],
                            ["Quote version", `v${file.data.quoteVersion}`],
                            ["Accepted at", formatIst(file.data.acceptedAt)],
                            ["Provisional", file.data.provisional ? "Yes" : "No"],
                        ]}
                    />
                </Panel>
            )}
        </div>
    );
}
