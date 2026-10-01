"use client";

// Ecofy lead uploader (M03, tracker ID 51 gap 11) — Sales Head / CEO only.
//
//   Single lead  → POST /api/ecofy/cases     (Ecofy POST /cases, starts at S1)
//   Bulk import  → /api/ecofy/imports/*      (upload → map → validate →
//                  consent + commit → status → row report)
//
// Field rules: src/lib/ecofy/intake.ts (OpenAPI CustomerIn / CaseCreate,
// template v0.3). Dropdowns are Ecofy's own lists (seed v1.1 list codes).

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
    caseCreateSchema,
    checkImportFile,
    DEFAULT_ATTESTATION_TEXT,
    IMPORT_TERMINAL,
    todayIstIso,
    unmappedRequiredColumns,
    type EcofyImport,
    type EcofyImportPreview,
} from "@/lib/ecofy/intake";
import { ecofyGet, ecofyPost, ecofyUpload, useLookup, type ListItem } from "./client";
import { Btn, Chip, Field, FormBox, fileInputCls, inputCls, KV, Panel } from "./ui";

const tabBtn = (on: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium ${
        on ? "bg-gray-900 text-white" : "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
    }`;

export function EcofyLeadUploader({ leadHrefBase }: { leadHrefBase: string }) {
    const [tab, setTab] = useState<"single" | "bulk">("single");
    return (
        <div className="space-y-4">
            <div className="flex gap-1">
                <button type="button" className={tabBtn(tab === "single")} onClick={() => setTab("single")}>
                    Single lead
                </button>
                <button type="button" className={tabBtn(tab === "bulk")} onClick={() => setTab("bulk")}>
                    Bulk import
                </button>
            </div>
            {tab === "single" ? <SingleLeadForm leadHrefBase={leadHrefBase} /> : <BulkImportWizard />}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Single lead
// ---------------------------------------------------------------------------

const EMPTY = {
    fullName: "",
    mobile: "",
    altMobile: "",
    email: "",
    customerType: "INDIVIDUAL",
    businessName: "",
    address: "",
    city: "",
    state: "",
    pincode: "",
    preferredLanguage: "",
    propertyType: "",
    segment: "RESI",
    productInterest: "",
    avgMonthlyBillInr: "",
    sanctionedLoadKw: "",
    existingBackup: "",
    preferredCallTime: "",
    consentObtained: false,
    consentDate: "",
    consentSource: "",
};

type Created = { caseId: string; caseNo: string | null; stage: string | null; owner: string | null; leadId: string | null };

/** An Ecofy list as a select; a free-text box if the list cannot be loaded. */
function ListSelect({
    list,
    value,
    onChange,
    required,
}: {
    list: "consent_source" | "language" | "property_type" | "product_interest" | "existing_backup" | "call_time";
    value: string;
    onChange: (v: string) => void;
    required?: boolean;
}) {
    const q = useLookup<ListItem>(list);
    if (q.error) return <input className={inputCls} required={required} value={value} onChange={(e) => onChange(e.target.value)} />;
    return (
        <select className={inputCls} required={required} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">{q.isLoading ? "Loading…" : required ? "Choose…" : "—"}</option>
            {(q.data ?? []).map((it) => (
                <option key={it.code} value={it.code}>
                    {it.label}
                </option>
            ))}
        </select>
    );
}

function SingleLeadForm({ leadHrefBase }: { leadHrefBase: string }) {
    const [f, setF] = useState({ ...EMPTY, consentDate: todayIstIso() });
    const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
    const [busy, setBusy] = useState(false);
    const [created, setCreated] = useState<Created | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
        setF((x) => ({ ...x, [k]: e.target.value }));
    const setV = (k: keyof typeof EMPTY) => (v: string) => setF((x) => ({ ...x, [k]: v }));

    async function submit() {
        const body = {
            customer: {
                fullName: f.fullName,
                mobile: f.mobile,
                altMobile: f.altMobile,
                email: f.email,
                customerType: f.customerType,
                businessName: f.customerType === "BUSINESS" ? f.businessName : "",
                address: f.address,
                city: f.city,
                state: f.state,
                pincode: f.pincode,
                preferredLanguage: f.preferredLanguage,
                propertyType: f.propertyType,
                consentObtained: f.consentObtained,
                consentDate: f.consentDate,
                consentSource: f.consentSource,
            },
            segment: f.segment,
            productInterest: f.productInterest,
            avgMonthlyBillInr: f.avgMonthlyBillInr,
            sanctionedLoadKw: f.sanctionedLoadKw,
            existingBackup: f.existingBackup,
            preferredCallTime: f.preferredCallTime,
        };
        const parsed = caseCreateSchema.safeParse(body);
        if (!parsed.success) {
            const first = parsed.error.issues[0];
            setProblem(`${first.path.join(".")}: ${first.message}`);
            return;
        }
        setProblem(null);
        setBusy(true);
        try {
            const r = await ecofyPost<Created>("/api/ecofy/cases", { ...parsed.data, idempotencyKey });
            setCreated(r);
            toast.success(`Lead created in Ecofy${r.caseNo ? ` — ${r.caseNo}` : ""}`);
            setF({ ...EMPTY, consentDate: todayIstIso() });
            setIdempotencyKey(crypto.randomUUID());
        } catch (e) {
            // Same key on retry: Ecofy replays the first result instead of creating twice.
            setProblem(e instanceof Error ? e.message : "Ecofy could not create the lead");
        } finally {
            setBusy(false);
        }
    }

    return (
        <Panel title="Create one lead in Ecofy" right="POST /cases · starts at S1, owned by iTarang">
            {created && (
                <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                    Created <b>{created.caseNo ?? created.caseId}</b> at {created.stage ?? "—"} (owner {created.owner ?? "—"}).{" "}
                    {created.leadId ? (
                        <Link href={`${leadHrefBase}/${created.leadId}`} className="font-medium text-emerald-800 underline">
                            Open the lead →
                        </Link>
                    ) : (
                        "It will show in the CRM once Ecofy sends it."
                    )}
                </div>
            )}
            <FormBox onSubmit={submit}>
                <Field label="Customer name *">
                    <input className={inputCls} required minLength={2} maxLength={100} value={f.fullName} onChange={set("fullName")} />
                </Field>
                <Field label="Mobile *" hint="10 digits starting 6–9, no +91">
                    <input className={inputCls} required inputMode="numeric" maxLength={10} value={f.mobile} onChange={set("mobile")} />
                </Field>
                <Field label="Customer type *">
                    <select className={inputCls} value={f.customerType} onChange={set("customerType")}>
                        <option value="INDIVIDUAL">Individual</option>
                        <option value="BUSINESS">Business</option>
                    </select>
                </Field>
                {f.customerType === "BUSINESS" ? (
                    <Field label="Business name *">
                        <input className={inputCls} required value={f.businessName} onChange={set("businessName")} />
                    </Field>
                ) : (
                    <Field label="Alternate mobile">
                        <input className={inputCls} inputMode="numeric" maxLength={10} value={f.altMobile} onChange={set("altMobile")} />
                    </Field>
                )}
                <Field label="Address *" wide>
                    <input className={inputCls} required minLength={3} maxLength={250} value={f.address} onChange={set("address")} />
                </Field>
                <Field label="City *">
                    <input className={inputCls} required value={f.city} onChange={set("city")} />
                </Field>
                <Field label="State *">
                    <input className={inputCls} required value={f.state} onChange={set("state")} />
                </Field>
                <Field label="Pincode *">
                    <input className={inputCls} required inputMode="numeric" maxLength={6} value={f.pincode} onChange={set("pincode")} />
                </Field>
                <Field label="Email">
                    <input className={inputCls} type="email" value={f.email} onChange={set("email")} />
                </Field>
                {f.customerType === "BUSINESS" && (
                    <Field label="Alternate mobile">
                        <input className={inputCls} inputMode="numeric" maxLength={10} value={f.altMobile} onChange={set("altMobile")} />
                    </Field>
                )}
                <Field label="Preferred language">
                    <ListSelect list="language" value={f.preferredLanguage} onChange={setV("preferredLanguage")} />
                </Field>
                <Field label="Property type">
                    <ListSelect list="property_type" value={f.propertyType} onChange={setV("propertyType")} />
                </Field>
                <Field label="Segment *">
                    <select className={inputCls} value={f.segment} onChange={set("segment")}>
                        <option value="RESI">Residential (RESI)</option>
                        <option value="ESS">ESS</option>
                        <option value="CI">C&amp;I</option>
                    </select>
                </Field>
                <Field label="Product interest">
                    <ListSelect list="product_interest" value={f.productInterest} onChange={setV("productInterest")} />
                </Field>
                <Field label="Avg monthly bill (₹, whole rupees)">
                    <input className={inputCls} type="number" min={0} step={1} value={f.avgMonthlyBillInr} onChange={set("avgMonthlyBillInr")} />
                </Field>
                <Field label="Sanctioned load (kW)">
                    <input className={inputCls} type="number" min={0} step="0.1" value={f.sanctionedLoadKw} onChange={set("sanctionedLoadKw")} />
                </Field>
                <Field label="Existing backup">
                    <ListSelect list="existing_backup" value={f.existingBackup} onChange={setV("existingBackup")} />
                </Field>
                <Field label="Preferred call time">
                    <ListSelect list="call_time" value={f.preferredCallTime} onChange={setV("preferredCallTime")} />
                </Field>

                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 sm:col-span-2">
                    <label className="flex items-start gap-2 text-sm text-amber-900">
                        <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={f.consentObtained}
                            onChange={(e) => setF((x) => ({ ...x, consentObtained: e.target.checked }))}
                        />
                        <span>
                            <b>Consent obtained *</b> — the customer agreed to be contacted (DPDP). A lead without consent cannot be created.
                        </span>
                    </label>
                    <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field label="Consent date *" hint="Not in the future">
                            <input className={inputCls} type="date" required max={todayIstIso()} value={f.consentDate} onChange={set("consentDate")} />
                        </Field>
                        <Field label="Consent source *">
                            <ListSelect list="consent_source" required value={f.consentSource} onChange={setV("consentSource")} />
                        </Field>
                    </div>
                </div>

                {problem && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 sm:col-span-2">{problem}</p>}
                <div className="flex justify-end sm:col-span-2">
                    <Btn type="submit" variant="primary" disabled={busy || !f.consentObtained}>
                        {busy ? "Creating…" : "Create lead in Ecofy"}
                    </Btn>
                </div>
            </FormBox>
        </Panel>
    );
}

// ---------------------------------------------------------------------------
// Bulk import wizard
// ---------------------------------------------------------------------------

type Started = {
    importId: string;
    fileName: string;
    headers: string[];
    suggestedMapping: Record<string, string>;
    templateColumns: string[];
    requiredColumns: string[];
};

function PreviewCounts({ p }: { p: EcofyImportPreview }) {
    return (
        <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                {(
                    [
                        ["Rows", p.rowCount],
                        ["Created", p.created],
                        ["Duplicate", p.duplicate],
                        ["Reopened", p.reopened],
                        ["New, linked", p.newLinked],
                        ["Rejected", p.rejected],
                    ] as Array<[string, number]>
                ).map(([k, v]) => (
                    <div key={k} className="rounded-lg border border-gray-200 bg-white p-2 text-center">
                        <div className="text-[11px] uppercase tracking-wide text-gray-500">{k}</div>
                        <div className={`text-lg font-semibold ${k === "Rejected" && v > 0 ? "text-red-700" : "text-gray-900"}`}>{v ?? 0}</div>
                    </div>
                ))}
            </div>
            {p.sampleErrors && p.sampleErrors.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="px-3 py-1.5">Row</th>
                                <th className="px-3 py-1.5">Column</th>
                                <th className="px-3 py-1.5">Code</th>
                                <th className="px-3 py-1.5">Message</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {p.sampleErrors.map((e, i) => (
                                <tr key={i}>
                                    <td className="px-3 py-1.5 tabular-nums">{e.rowNo}</td>
                                    <td className="px-3 py-1.5">{e.column ?? "—"}</td>
                                    <td className="px-3 py-1.5 font-mono text-xs">{e.code}</td>
                                    <td className="px-3 py-1.5">{e.message ?? "—"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="px-3 py-1.5 text-xs text-gray-500">Sample only — the full row report is available after commit.</p>
                </div>
            )}
        </div>
    );
}

function BulkImportWizard() {
    const [file, setFile] = useState<File | null>(null);
    const [started, setStarted] = useState<Started | null>(null);
    const [mapping, setMapping] = useState<Record<string, string>>({});
    const [saveAs, setSaveAs] = useState("");
    const [preview, setPreview] = useState<EcofyImportPreview | null>(null);
    const [consent, setConsent] = useState(false);
    const [attestation, setAttestation] = useState(DEFAULT_ATTESTATION_TEXT);
    const [commitKey, setCommitKey] = useState(() => crypto.randomUUID());
    const [imp, setImp] = useState<EcofyImport | null>(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const missing = useMemo(() => (started ? unmappedRequiredColumns(mapping) : []), [started, mapping]);
    const targets = Object.values(mapping);
    const dupTargets = targets.filter((t, i) => targets.indexOf(t) !== i);

    // Commit is a background job (FR-03.5): poll until COMMITTED / FAILED.
    useEffect(() => {
        if (!imp || IMPORT_TERMINAL.includes(imp.status) || !started) return;
        const t = setInterval(async () => {
            try {
                setImp(await ecofyGet<EcofyImport>(`/api/ecofy/imports/${started.importId}`));
            } catch (e) {
                setErr(e instanceof Error ? e.message : "Could not read the import status");
            }
        }, 3000);
        return () => clearInterval(t);
    }, [imp, started]);

    function reset() {
        setFile(null);
        setStarted(null);
        setMapping({});
        setSaveAs("");
        setPreview(null);
        setConsent(false);
        setAttestation(DEFAULT_ATTESTATION_TEXT);
        setCommitKey(crypto.randomUUID());
        setImp(null);
        setErr(null);
    }

    async function step<T>(fn: () => Promise<T>): Promise<T | undefined> {
        setBusy(true);
        setErr(null);
        try {
            return await fn();
        } catch (e) {
            setErr(e instanceof Error ? e.message : "The import step failed");
            return undefined;
        } finally {
            setBusy(false);
        }
    }

    async function upload() {
        if (!file) return;
        const bad = checkImportFile(file.name, file.size);
        if (bad) return setErr(bad);
        const form = new FormData();
        form.set("file", file);
        const r = await step(() => ecofyUpload<Started>("/api/ecofy/imports", form));
        if (r) {
            setStarted(r);
            setMapping(r.suggestedMapping);
        }
    }

    async function mapAndValidate() {
        if (!started) return;
        const r = await step(async () => {
            await ecofyPost(`/api/ecofy/imports/${started.importId}/mapping`, { mapping, saveAs: saveAs || undefined });
            return ecofyPost<EcofyImportPreview>(`/api/ecofy/imports/${started.importId}/validate`, {});
        });
        if (r) setPreview(r);
    }

    async function commit() {
        if (!started) return;
        const r = await step(() =>
            ecofyPost<EcofyImport>(`/api/ecofy/imports/${started.importId}/commit`, {
                consentAttested: true,
                attestationText: attestation,
                idempotencyKey: commitKey,
            }),
        );
        if (r) {
            setImp(r);
            toast.success("Import committed — Ecofy is processing it");
        }
    }

    const reportHref = started ? `/api/ecofy/imports/${started.importId}/report` : "#";

    return (
        <div className="space-y-4">
            <Panel
                title="1 · Upload the lead file"
                right={
                    // eslint-disable-next-line @next/next/no-html-link-for-pages -- a file download from an API route, not a page
                    <a href="/api/ecofy/imports/template" className="text-blue-700 hover:underline">
                        Download template v0.3
                    </a>
                }
            >
                <p className="mb-3 text-xs text-gray-500">
                    .xlsx or .csv, up to 10 MB (Ecofy accepts up to 5,000 rows). Fill the template&apos;s “Leads” sheet; never include
                    Aadhaar, PAN, bank, income or loan data. Leads imported by iTarang start at S1, owned by iTarang.
                </p>
                <div className="flex flex-wrap items-end gap-2">
                    <input
                        type="file"
                        accept=".xlsx,.csv"
                        className={`${fileInputCls} max-w-md`}
                        disabled={Boolean(started)}
                        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    />
                    {!started ? (
                        <Btn variant="primary" disabled={!file || busy} onClick={upload}>
                            {busy ? "Uploading…" : "Upload"}
                        </Btn>
                    ) : (
                        <Btn onClick={reset}>Start over</Btn>
                    )}
                </div>
                {started && (
                    <p className="mt-2 text-xs text-gray-600">
                        Uploaded <b>{started.fileName}</b> · {started.headers.length} columns found · import {started.importId.slice(0, 8)}
                    </p>
                )}
            </Panel>

            {started && (
                <Panel title="2 · Map the columns" right="headers named like the template are matched automatically">
                    <div className="overflow-x-auto rounded-lg border border-gray-200">
                        <table className="min-w-full text-sm">
                            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                                <tr>
                                    <th className="px-3 py-1.5">Column in your file</th>
                                    <th className="px-3 py-1.5">Template column</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {started.headers.map((h) => (
                                    <tr key={h}>
                                        <td className="px-3 py-1.5 text-gray-900">{h}</td>
                                        <td className="px-3 py-1.5">
                                            <select
                                                className={inputCls}
                                                disabled={Boolean(preview)}
                                                value={mapping[h] ?? ""}
                                                onChange={(e) =>
                                                    setMapping((m) => {
                                                        const next = { ...m };
                                                        if (e.target.value) next[h] = e.target.value;
                                                        else delete next[h];
                                                        return next;
                                                    })
                                                }
                                            >
                                                <option value="">— not imported —</option>
                                                {started.templateColumns.map((c) => (
                                                    <option key={c} value={c}>
                                                        {c}
                                                        {started.requiredColumns.includes(c) ? " *" : ""}
                                                    </option>
                                                ))}
                                            </select>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {missing.length > 0 && (
                        <p className="mt-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
                            Mandatory template columns not mapped: {missing.join(", ")}. Rows without them will be rejected.
                        </p>
                    )}
                    {dupTargets.length > 0 && (
                        <p className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-700">
                            Mapped more than once: {[...new Set(dupTargets)].join(", ")}.
                        </p>
                    )}
                    <div className="mt-3 flex flex-wrap items-end gap-2">
                        <Field label="Save this mapping as (optional, per source)">
                            <input className={inputCls} maxLength={60} disabled={Boolean(preview)} value={saveAs} onChange={(e) => setSaveAs(e.target.value)} />
                        </Field>
                        <Btn variant="primary" disabled={busy || Boolean(preview) || dupTargets.length > 0 || targets.length === 0} onClick={mapAndValidate}>
                            {busy && !preview ? "Validating…" : "Save mapping & validate"}
                        </Btn>
                    </div>
                </Panel>
            )}

            {preview && (
                <Panel title="3 · Preview and commit" right="dry run — nothing is created until you commit">
                    <PreviewCounts p={preview} />
                    {!imp && (
                        <div className="mt-4 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                            <label className="flex items-start gap-2 text-sm text-amber-900">
                                <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                                <span>
                                    <b>Consent confirmation *</b> — required to commit. The text below and the time are logged in Ecofy.
                                </span>
                            </label>
                            <textarea className={inputCls} rows={2} maxLength={1000} value={attestation} onChange={(e) => setAttestation(e.target.value)} />
                            <div className="flex justify-end gap-2">
                                <Btn onClick={reset}>Cancel</Btn>
                                <Btn variant="primary" disabled={busy || !consent || attestation.trim().length < 10} onClick={commit}>
                                    {busy ? "Committing…" : `Commit import`}
                                </Btn>
                            </div>
                        </div>
                    )}
                </Panel>
            )}

            {imp && (
                <Panel title="4 · Import status" right={<a href={reportHref} className="text-blue-700 hover:underline">Download row report (CSV)</a>}>
                    <div className="mb-3 flex items-center gap-2 text-sm">
                        <Chip tone={imp.status === "COMMITTED" ? "green" : imp.status === "FAILED" ? "red" : "amber"}>{imp.status}</Chip>
                        {!IMPORT_TERMINAL.includes(imp.status) && <span className="text-gray-500">Ecofy is processing the file — checking every few seconds…</span>}
                    </div>
                    {imp.preview && <PreviewCounts p={imp.preview} />}
                    {imp.status === "COMMITTED" && (
                        <KV
                            rows={[
                                ["Next", "Created leads appear in the Pickup Queue once Ecofy sends them to the CRM."],
                                ["Rejected rows", "Fix them from the row report and upload only those rows again."],
                            ]}
                        />
                    )}
                    <div className="mt-3">
                        <Btn onClick={reset}>Import another file</Btn>
                    </div>
                </Panel>
            )}

            {err && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        </div>
    );
}
