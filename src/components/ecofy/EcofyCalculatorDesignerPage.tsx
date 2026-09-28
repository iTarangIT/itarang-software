"use client";

// Calculator designer (Ecofy M08, CONFLICTS #31), moved from Ecofy's
// /calculator/designer into the CRM. The 9-step formula is fixed (FR-08.8);
// the Sales Head edits values, segments, input methods, appliances,
// recommendation rules, display texts and the standard systems in a DRAFT,
// checks every step on the test bench, submits and publishes. Ecofy keeps the
// state machine, validation and audit; every write lands in the outbound
// ledger. Every assessment stores the release it used.

import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ecofyGet, ecofyPost, ecofyUpload } from "./client";
import { EcofyCalculator } from "./EcofyCalculator";
import { Btn, Chip, Empty, ErrorNote, Loading, fileInputCls, inputCls } from "./ui";

type Release = {
    id: string;
    version: number;
    status: string;
    changeNote: string | null;
    decisionNote: string | null;
    createdAt: string;
    submittedAt: string | null;
    publishedAt: string | null;
};
type Appliance = { name: string; defaultWatts: number; isMotor: boolean; startMultiplier: number; sortOrder?: number; active?: boolean };
type System = {
    systemCode: string;
    systemName: string;
    systemType: string;
    phase: string;
    usableCapacityKwh: number;
    inverterKva: number;
    solarKwp: number;
    equipmentPriceMinInr: number;
    equipmentPriceMaxInr: number;
    installationPriceMinInr: number;
    installationPriceMaxInr: number;
    gstPct: number;
    priceUpdatedOn: string;
    active: boolean;
};
type Bundle = Release & { params: Record<string, unknown>; appliances: Appliance[]; systems: System[] };
type ImportResult = { imported: number; rejected: Array<{ rowNo: number; code: string; reason: string }> };

type Tab = "Values & rules" | "Appliances" | "Standard systems" | "Test bench";
const TABS: Tab[] = ["Values & rules", "Appliances", "Standard systems", "Test bench"];

const STATUS_TONE: Record<string, "green" | "sky" | "amber" | "red" | "gray"> = {
    PUBLISHED: "green",
    DRAFT: "sky",
    PENDING_APPROVAL: "amber",
    REJECTED: "red",
    RETIRED: "gray",
};

const inr = (v: number) => `₹${Number(v).toLocaleString("en-IN")}`;
const fmtDateTime = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";

async function ecofyPatch<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return unwrapResponse<T>(res);
}
async function ecofyPut<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return unwrapResponse<T>(res);
}
async function unwrapResponse<T>(res: Response): Promise<T> {
    let json: { success?: boolean; data?: T; error?: { message?: string } } | null = null;
    try {
        json = await res.json();
    } catch {
        /* non-JSON */
    }
    if (!res.ok || json?.success === false) throw new Error(json?.error?.message ?? `Request failed (${res.status})`);
    return json?.data as T;
}

export function EcofyCalculatorDesignerPage() {
    const qc = useQueryClient();
    const list = useQuery({ queryKey: ["ecofy-calc-releases"], queryFn: () => ecofyGet<Release[]>("/api/ecofy/calculator/releases") });
    const [sel, setSel] = useState<string | null>(null);
    const releases = useMemo(() => list.data ?? [], [list.data]);
    // Default to the release that needs work: an open draft / pending one, else the published one.
    const current =
        sel ??
        releases.find((r) => r.status === "DRAFT" || r.status === "PENDING_APPROVAL")?.id ??
        releases.find((r) => r.status === "PUBLISHED")?.id ??
        null;
    const bundle = useQuery({
        queryKey: ["ecofy-calc-release", current],
        enabled: Boolean(current),
        queryFn: () => ecofyGet<Bundle>(`/api/ecofy/calculator/releases/${current}`),
    });
    const b = bundle.data;
    const [tab, setTab] = useState<Tab>("Values & rules");
    const [busy, setBusy] = useState(false);
    const [flash, setFlash] = useState<{ text: string; bad?: boolean } | null>(null);
    const hasOpen = releases.some((r) => r.status === "DRAFT" || r.status === "PENDING_APPROVAL");
    const isDraft = b?.status === "DRAFT";

    const refresh = () => {
        void qc.invalidateQueries({ queryKey: ["ecofy-calc-releases"] });
        void qc.invalidateQueries({ queryKey: ["ecofy-calc-release"] });
        // the calculator screen and the test bench cache the release they run on
        void qc.invalidateQueries({ queryKey: ["ecofy-calculator-release"] });
    };
    const run = async (label: string, fn: () => Promise<unknown>) => {
        setBusy(true);
        setFlash(null);
        try {
            await fn();
            setFlash({ text: label });
            refresh();
        } catch (e) {
            setFlash({ text: e instanceof Error ? e.message : "Ecofy refused the change", bad: true });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Ecofy — Calculator designer</h1>
                <p className="mt-1 text-sm text-gray-600">
                    The 9-step formula is fixed. Edit the values, segments, input methods, appliances, recommendation rules,
                    display texts and the standard systems in a <b>draft</b>; the test bench shows every step; then submit and
                    publish (the previous release is retired). Every assessment stores the release it used.
                </p>
            </header>

            {flash && (
                <p
                    className={`rounded-lg border p-3 text-sm ${
                        flash.bad ? "border-red-100 bg-red-50 text-red-700" : "border-emerald-100 bg-emerald-50 text-emerald-900"
                    }`}
                >
                    {flash.text}{" "}
                    <button type="button" className="text-xs underline" onClick={() => setFlash(null)}>
                        dismiss
                    </button>
                </p>
            )}

            <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
                <section className="self-start rounded-xl border border-gray-200 bg-white shadow-sm">
                    <header className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                        <h2 className="text-sm font-semibold text-gray-900">Releases</h2>
                        {list.data && !hasOpen && (
                            <NoteAction
                                label="+ Draft"
                                prompt="Change note for the new draft"
                                required
                                busy={busy}
                                variant="primary"
                                onConfirm={(n) => run("Draft created", () => ecofyPost("/api/ecofy/calculator/releases", { changeNote: n }))}
                            />
                        )}
                    </header>
                    {list.isLoading ? (
                        <div className="p-4">
                            <Loading />
                        </div>
                    ) : list.error ? (
                        <div className="p-4">
                            <ErrorNote error={list.error} />
                        </div>
                    ) : null}
                    {releases.map((r) => (
                        <button
                            key={r.id}
                            type="button"
                            className={`block w-full border-b border-gray-100 px-4 py-2.5 text-left text-sm hover:bg-gray-50 ${
                                current === r.id ? "bg-sky-50" : ""
                            }`}
                            onClick={() => setSel(r.id)}
                        >
                            <div className="flex items-center gap-2">
                                <b className="text-gray-900">v{r.version}</b>
                                <Chip tone={STATUS_TONE[r.status] ?? "gray"}>{r.status.replace(/_/g, " ")}</Chip>
                            </div>
                            {r.changeNote && <div className="mt-0.5 text-xs text-gray-500">{r.changeNote}</div>}
                        </button>
                    ))}
                    {list.data && releases.length === 0 && (
                        <div className="p-4">
                            <Empty>No releases yet — create the first draft.</Empty>
                        </div>
                    )}
                </section>

                <div className="space-y-5">
                    {bundle.isLoading && <Loading />}
                    {bundle.error ? <ErrorNote error={bundle.error} /> : null}
                    {b && (
                        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
                            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
                                <h2 className="text-sm font-semibold text-gray-900">
                                    Release v{b.version} <Chip tone={STATUS_TONE[b.status] ?? "gray"}>{b.status.replace(/_/g, " ")}</Chip>
                                </h2>
                                <div className="flex flex-wrap items-center gap-2">
                                    {isDraft && (
                                        <NoteAction
                                            label="Submit for approval"
                                            prompt="Note for the approver (optional)"
                                            busy={busy}
                                            variant="primary"
                                            onConfirm={(n) =>
                                                run("Submitted for approval", () =>
                                                    ecofyPost(`/api/ecofy/calculator/releases/${b.id}/submit`, { note: n || undefined }),
                                                )
                                            }
                                        />
                                    )}
                                    {b.status === "PENDING_APPROVAL" && (
                                        <>
                                            <NoteAction
                                                label="Approve & publish"
                                                prompt="Approval note (optional)"
                                                busy={busy}
                                                variant="success"
                                                onConfirm={(n) =>
                                                    run("Published — the calculator now runs on v" + b.version, () =>
                                                        ecofyPost(`/api/ecofy/calculator/releases/${b.id}/approve`, { note: n || undefined }),
                                                    )
                                                }
                                            />
                                            <NoteAction
                                                label="Reject"
                                                prompt="Rejection note (required)"
                                                required
                                                busy={busy}
                                                variant="danger"
                                                onConfirm={(n) =>
                                                    run("Rejected — back to draft", () =>
                                                        ecofyPost(`/api/ecofy/calculator/releases/${b.id}/reject`, { note: n }),
                                                    )
                                                }
                                            />
                                        </>
                                    )}
                                    {["RETIRED", "PUBLISHED", "REJECTED"].includes(b.status) && !hasOpen && (
                                        <NoteAction
                                            label="Restore as draft"
                                            prompt="Change note for the restored draft"
                                            required
                                            busy={busy}
                                            onConfirm={(n) =>
                                                run("Copied into a new draft", () =>
                                                    ecofyPost(`/api/ecofy/calculator/releases/${b.id}/restore`, { changeNote: n }),
                                                )
                                            }
                                        />
                                    )}
                                </div>
                            </header>
                            <div className="space-y-3 p-4">
                                <p className="text-xs text-gray-500">
                                    {b.changeNote} · created {fmtDateTime(b.createdAt)}
                                    {b.submittedAt ? ` · submitted ${fmtDateTime(b.submittedAt)}` : ""}
                                    {b.publishedAt ? ` · published ${fmtDateTime(b.publishedAt)}` : ""}
                                    {b.decisionNote ? ` · decision: ${b.decisionNote}` : ""}
                                </p>
                                <div className="flex flex-wrap gap-1">
                                    {TABS.map((t) => (
                                        <button
                                            key={t}
                                            type="button"
                                            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                                                tab === t ? "bg-gray-900 text-white" : "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
                                            }`}
                                            onClick={() => setTab(t)}
                                        >
                                            {t}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </section>
                    )}

                    {b && tab === "Values & rules" && (
                        <ParamsEditor key={`${b.id}-${JSON.stringify(b.params).length}-${b.status}`} b={b} canEdit={isDraft} run={run} busy={busy} />
                    )}
                    {b && tab === "Appliances" && <AppliancesEditor key={`${b.id}-${b.appliances.length}`} b={b} canEdit={isDraft} run={run} busy={busy} />}
                    {b && tab === "Standard systems" && <SystemsEditor b={b} canEdit={isDraft} run={run} busy={busy} />}
                    {b && tab === "Test bench" && (
                        <Section title={`Test bench — every step against v${b.version}`} right="the worked example is preloaded">
                            <EcofyCalculator key={b.id} segment="RESI" releaseId={b.id} defaults={{ monthlyUnits: 300 }} />
                        </Section>
                    )}
                </div>
            </div>
        </div>
    );
}

function Section({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
    return (
        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
                <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
                {right ? <div className="text-xs text-gray-500">{right}</div> : null}
            </header>
            <div className="p-4">{children}</div>
        </section>
    );
}

/** A button that opens a one-line note box and confirms, instead of window.prompt. */
function NoteAction({
    label,
    prompt,
    required,
    busy,
    variant = "default",
    onConfirm,
}: {
    label: string;
    prompt: string;
    required?: boolean;
    busy: boolean;
    variant?: "default" | "primary" | "danger" | "success";
    onConfirm: (note: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [note, setNote] = useState("");
    if (!open) {
        return (
            <Btn variant={variant} disabled={busy} onClick={() => setOpen(true)}>
                {label}
            </Btn>
        );
    }
    const ok = !required || note.trim().length >= 3;
    return (
        <span className="flex flex-wrap items-center gap-1 rounded-lg bg-gray-50 p-1.5">
            <input
                className={`${inputCls} w-64`}
                autoFocus
                placeholder={prompt}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && ok) {
                        onConfirm(note.trim());
                        setOpen(false);
                        setNote("");
                    }
                    if (e.key === "Escape") setOpen(false);
                }}
            />
            <Btn
                variant={variant}
                disabled={busy || !ok}
                onClick={() => {
                    onConfirm(note.trim());
                    setOpen(false);
                    setNote("");
                }}
            >
                {label}
            </Btn>
            <Btn onClick={() => setOpen(false)}>Cancel</Btn>
        </span>
    );
}

type Run = (label: string, fn: () => Promise<unknown>) => Promise<void>;

function ParamsEditor({ b, canEdit, run, busy }: { b: Bundle; canEdit: boolean; run: Run; busy: boolean }) {
    const pretty = useMemo(() => JSON.stringify(b.params, null, 2), [b.params]);
    // Remounted by the parent's key whenever the saved params change, so no
    // effect is needed to drop a stale edit.
    const [text, setText] = useState<string | null>(null);
    const [jsonError, setJsonError] = useState<string | null>(null);
    const value = text ?? pretty;

    const save = () => {
        let params: Record<string, unknown>;
        try {
            params = JSON.parse(value);
            setJsonError(null);
        } catch (e) {
            setJsonError(e instanceof Error ? e.message : "Invalid JSON");
            return;
        }
        void run("Draft saved", () => ecofyPatch(`/api/ecofy/calculator/releases/${b.id}`, { params }));
    };

    return (
        <Section title="Values, segments, input methods, rules, display, texts (JSON)" right="formula: FIXED_9_STEP_V1">
            <textarea
                className={`${inputCls} h-[440px] font-mono text-xs`}
                readOnly={!canEdit}
                value={value}
                onChange={(e) => setText(e.target.value)}
                spellCheck={false}
            />
            {jsonError && <p className="mt-2 text-sm text-red-700">Not valid JSON: {jsonError}</p>}
            {!canEdit && <p className="mt-2 text-xs text-gray-500">Read-only — only a DRAFT can be edited.</p>}
            {canEdit && (
                <div className="mt-2 flex justify-end gap-2">
                    <Btn disabled={busy || text === null} onClick={() => setText(null)}>
                        Discard
                    </Btn>
                    <Btn variant="primary" disabled={busy || text === null} onClick={save}>
                        Save draft
                    </Btn>
                </div>
            )}
        </Section>
    );
}

function AppliancesEditor({ b, canEdit, run, busy }: { b: Bundle; canEdit: boolean; run: Run; busy: boolean }) {
    const [rows, setRows] = useState<Appliance[]>(b.appliances.map((a) => ({ ...a, active: a.active ?? true })));
    const setRow = (i: number, patch: Partial<Appliance>) => setRows((x) => x.map((y, j) => (j === i ? { ...y, ...patch } : y)));
    const save = () =>
        run("Appliances saved", () =>
            ecofyPut(
                `/api/ecofy/calculator/releases/${b.id}/appliances`,
                rows.map((r, i) => ({
                    name: r.name.trim(),
                    defaultWatts: Number(r.defaultWatts),
                    isMotor: r.isMotor,
                    startMultiplier: Number(r.startMultiplier),
                    sortOrder: i + 1,
                    active: r.active ?? true,
                })),
            ),
        );

    return (
        <Section
            title="Appliances (watts, motor flag, starting multiplier)"
            right={
                canEdit ? (
                    <Btn variant="primary" disabled={busy} onClick={save}>
                        Save
                    </Btn>
                ) : (
                    "read-only — only a DRAFT can be edited"
                )
            }
        >
            <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                        <tr>
                            <th className="py-2 pr-4">Name</th>
                            <th className="py-2 pr-4">Watts</th>
                            <th className="py-2 pr-4">Motor</th>
                            <th className="py-2 pr-4">Start ×</th>
                            <th className="py-2 pr-4">Active</th>
                            <th className="py-2" />
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {rows.map((r, i) => (
                            <tr key={i}>
                                <td className="py-1.5 pr-4">
                                    <input className={inputCls} disabled={!canEdit} value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} />
                                </td>
                                <td className="py-1.5 pr-4">
                                    <input
                                        className={`${inputCls} w-24 tabular-nums`}
                                        type="number"
                                        min={1}
                                        disabled={!canEdit}
                                        value={r.defaultWatts}
                                        onChange={(e) => setRow(i, { defaultWatts: Number(e.target.value) })}
                                    />
                                </td>
                                <td className="py-1.5 pr-4">
                                    <input type="checkbox" disabled={!canEdit} checked={r.isMotor} onChange={(e) => setRow(i, { isMotor: e.target.checked })} />
                                </td>
                                <td className="py-1.5 pr-4">
                                    <input
                                        className={`${inputCls} w-20 tabular-nums`}
                                        type="number"
                                        step="0.5"
                                        min={1}
                                        max={8}
                                        disabled={!canEdit}
                                        value={r.startMultiplier}
                                        onChange={(e) => setRow(i, { startMultiplier: Number(e.target.value) })}
                                    />
                                </td>
                                <td className="py-1.5 pr-4">
                                    <input type="checkbox" disabled={!canEdit} checked={r.active ?? true} onChange={(e) => setRow(i, { active: e.target.checked })} />
                                </td>
                                <td className="py-1.5">
                                    {canEdit && (
                                        <button
                                            type="button"
                                            aria-label="Remove"
                                            className="text-gray-400 hover:text-red-600"
                                            onClick={() => setRows((x) => x.filter((_, j) => j !== i))}
                                        >
                                            ✕
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {rows.length === 0 && <Empty>No appliances in this release.</Empty>}
            {canEdit && (
                <div className="mt-3">
                    <Btn onClick={() => setRows((x) => [...x, { name: "", defaultWatts: 100, isMotor: false, startMultiplier: 1, active: true }])}>
                        + Appliance
                    </Btn>
                </div>
            )}
        </Section>
    );
}

function SystemsEditor({ b, canEdit, run, busy }: { b: Bundle; canEdit: boolean; run: Run; busy: boolean }) {
    const [file, setFile] = useState<File | null>(null);
    const [replaceAll, setReplaceAll] = useState(false);
    const [rejected, setRejected] = useState<ImportResult["rejected"]>([]);
    const [inputKey, setInputKey] = useState(0);

    const importFile = () => {
        if (!file) return;
        void run("Systems imported", async () => {
            const form = new FormData();
            form.append("file", file);
            form.append("replaceAll", String(replaceAll));
            const r = await ecofyUpload<ImportResult>(`/api/ecofy/calculator/releases/${b.id}/systems-import`, form);
            setRejected(r.rejected);
            setFile(null);
            setInputKey((k) => k + 1);
            if (r.rejected.length) throw new Error(`${r.imported} imported, ${r.rejected.length} rows rejected — see the reasons below`);
        });
    };

    return (
        <div className="space-y-5">
            <Section title={`Standard systems (${b.systems.length})`} right="prices are indicative ranges incl. iTarang's margin; retire with active=N, never delete">
                {b.systems.length === 0 ? (
                    <Empty>No standard systems in this release. Import the standard systems template v0.2.</Empty>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="min-w-full text-xs">
                            <thead className="text-left uppercase tracking-wide text-gray-500">
                                <tr>
                                    <th className="py-2 pr-3">Code</th>
                                    <th className="py-2 pr-3">Name</th>
                                    <th className="py-2 pr-3">Type / phase</th>
                                    <th className="py-2 pr-3">Usable kWh</th>
                                    <th className="py-2 pr-3">kVA</th>
                                    <th className="py-2 pr-3">kWp</th>
                                    <th className="py-2 pr-3">Equipment</th>
                                    <th className="py-2 pr-3">Installation</th>
                                    <th className="py-2 pr-3">GST</th>
                                    <th className="py-2 pr-3">Price date</th>
                                    <th className="py-2">Active</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {b.systems.map((s) => (
                                    <tr key={s.systemCode} className={s.active ? "" : "text-gray-400"}>
                                        <td className="py-1.5 pr-3 font-mono">{s.systemCode}</td>
                                        <td className="py-1.5 pr-3 text-gray-900">{s.systemName}</td>
                                        <td className="py-1.5 pr-3">
                                            {s.systemType.replace(/_/g, " ").toLowerCase()} · {s.phase.toLowerCase()}
                                        </td>
                                        <td className="py-1.5 pr-3 tabular-nums">{s.usableCapacityKwh}</td>
                                        <td className="py-1.5 pr-3 tabular-nums">{s.inverterKva}</td>
                                        <td className="py-1.5 pr-3 tabular-nums">{s.solarKwp}</td>
                                        <td className="py-1.5 pr-3 tabular-nums">
                                            {inr(s.equipmentPriceMinInr)}–{inr(s.equipmentPriceMaxInr)}
                                        </td>
                                        <td className="py-1.5 pr-3 tabular-nums">
                                            {inr(s.installationPriceMinInr)}–{inr(s.installationPriceMaxInr)}
                                        </td>
                                        <td className="py-1.5 pr-3 tabular-nums">{s.gstPct}%</td>
                                        <td className="py-1.5 pr-3 tabular-nums">{s.priceUpdatedOn}</td>
                                        <td className="py-1.5">{s.active ? "Y" : "N"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Section>
            {canEdit && (
                <Section
                    title="Import standard systems (template v0.2)"
                    right={
                        <a className="text-blue-700 hover:underline" href="/templates/Ecofy_Standard_Systems_Template_v0.2.xlsx" download>
                            download template
                        </a>
                    }
                >
                    <div className="flex flex-wrap items-end gap-3">
                        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                            Template (.xlsx or .csv)
                            <input
                                key={inputKey}
                                type="file"
                                accept=".xlsx,.xls,.csv"
                                className={`${fileInputCls} max-w-sm`}
                                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                            />
                        </label>
                        <label className="flex items-center gap-1.5 pb-2 text-sm text-gray-700">
                            <input type="checkbox" checked={replaceAll} onChange={(e) => setReplaceAll(e.target.checked)} /> Replace all rows
                        </label>
                        <div className="pb-0.5">
                            <Btn variant="primary" disabled={busy || !file} onClick={importFile}>
                                Import
                            </Btn>
                        </div>
                    </div>
                    <p className="mt-2 text-xs text-gray-500">
                        Without &quot;Replace all rows&quot;, rows with a code already in the release overwrite it and the others are added.
                    </p>
                    {rejected.length > 0 && (
                        <div className="mt-3 max-h-[220px] overflow-y-auto rounded-lg bg-red-50 p-3 text-xs text-red-800">
                            {rejected.map((r, i) => (
                                <div key={i}>
                                    <span className="font-mono">row {r.rowNo}</span> {r.code ? `${r.code}: ` : ""}
                                    {r.reason}
                                </div>
                            ))}
                        </div>
                    )}
                </Section>
            )}
        </div>
    );
}
