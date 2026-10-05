"use client";

// E-322 (tracker IDs 39, 71) — Invoice Ledger: Import · Item mapping ·
// By SKU · Reconciliation. Every write goes through a preview first.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Upload } from "lucide-react";

import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

type Tab = "import" | "items" | "sku" | "recon";

const inr = (n: number | null | undefined) =>
    n == null ? "—" : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

async function readData<T>(res: Response, fallback: string): Promise<T> {
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? json?.error ?? fallback);
    return json.data as T;
}

export function InvoiceLedgerView() {
    const [tab, setTab] = useState<Tab>("import");
    return (
        <div className="space-y-4">
            <Tabs
                value={tab}
                onValueChange={(v) => setTab(v as Tab)}
                tabs={[
                    { value: "import", label: "Import" },
                    { value: "items", label: "Item mapping" },
                    { value: "sku", label: "By SKU" },
                    { value: "recon", label: "GSTR-1 reconciliation" },
                ]}
            />
            <div className="rounded-xl border border-border bg-surface shadow-card p-5">
                {tab === "import" && <ImportTab />}
                {tab === "items" && <ItemsTab />}
                {tab === "sku" && <SkuTab />}
                {tab === "recon" && <ReconTab />}
            </div>
        </div>
    );
}

// ── Import ──────────────────────────────────────────────────────────────────

type Preview = {
    kind: string;
    sheet: string | null;
    columns: Record<string, string>;
    unknown_columns: string[];
    warnings: string[];
    period: { from: string | null; to: string | null };
    totals: { documents: number; update: number; create: number; cancelled: number; lines: number; batteries: number; unmapped_items: number };
    unmapped_items: string[];
    rows: Array<{ number: string; date: string | null; party: string | null; gstin: string | null; doc_type: string; cancelled: boolean; lines: number; batteries: number; taxable: number | null; action: string }>;
};

function ImportTab() {
    const qc = useQueryClient();
    const [file, setFile] = useState<File | null>(null);
    const [kind, setKind] = useState<"vyapar_register" | "gstr1">("vyapar_register");
    const [preview, setPreview] = useState<Preview | null>(null);

    const history = useQuery({
        queryKey: ["invoice-ledger-imports"],
        queryFn: async () =>
            readData<{ imports: Array<{ id: string; kind: string; file_name: string | null; period_from: string | null; period_to: string | null; summary: Record<string, number> | null; created_at: string; imported_by: string | null }> }>(
                await fetch("/api/admin/sales-invoices/ledger/import"),
                "Could not load imports",
            ),
    });

    const send = useMutation({
        mutationFn: async (mode: "preview" | "commit") => {
            if (!file) throw new Error("Choose a file first");
            const fd = new FormData();
            fd.append("file", file);
            fd.append("kind", kind);
            fd.append("mode", mode);
            return readData<{ mode: string; preview?: Preview; summary?: Record<string, number> }>(
                await fetch("/api/admin/sales-invoices/ledger/import", { method: "POST", body: fd }),
                "Import failed",
            );
        },
        onSuccess: (data) => {
            if (data.mode === "preview") {
                setPreview(data.preview ?? null);
                return;
            }
            const s = data.summary ?? {};
            toast.success(
                kind === "gstr1"
                    ? `GSTR-1 imported: ${s.documents ?? 0} documents.`
                    : `Imported ${s.documents ?? 0} invoices (${s.created_ids ?? 0} new, ${s.voided ?? 0} voided as cancelled).`,
            );
            setPreview(null);
            setFile(null);
            qc.invalidateQueries({ queryKey: ["invoice-ledger-imports"] });
            qc.invalidateQueries({ queryKey: ["invoice-ledger-items"] });
        },
        onError: (e) => toast.error((e as Error).message),
    });

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-end gap-3">
                <label className="block">
                    <span className="text-xs font-medium text-ink">What is the file?</span>
                    <select
                        value={kind}
                        onChange={(e) => {
                            setKind(e.target.value as typeof kind);
                            setPreview(null);
                        }}
                        className="mt-1 block rounded-md border border-border bg-surface px-3 py-2 text-sm"
                    >
                        <option value="vyapar_register">Vyapar sales register (weekly)</option>
                        <option value="gstr1">GSTR-1 as filed (monthly)</option>
                    </select>
                </label>
                <label className="block">
                    <span className="text-xs font-medium text-ink">File (.xlsx, .xls, .csv)</span>
                    <input
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        onChange={(e) => {
                            setFile(e.target.files?.[0] ?? null);
                            setPreview(null);
                        }}
                        className="mt-1 block text-sm"
                    />
                </label>
                <Button variant="outline" disabled={!file || send.isPending} onClick={() => send.mutate("preview")}>
                    {send.isPending && send.variables === "preview" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                    Preview
                </Button>
            </div>

            {preview && (
                <div className="space-y-3">
                    {preview.warnings.length > 0 && (
                        <ul className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 list-disc pl-6">
                            {preview.warnings.slice(0, 8).map((w) => (
                                <li key={w}>{w}</li>
                            ))}
                        </ul>
                    )}
                    <div className="text-xs text-ink-muted space-y-1">
                        <p>
                            Sheet <strong>{preview.sheet ?? "—"}</strong> · {preview.period.from ?? "?"} to {preview.period.to ?? "?"} ·{" "}
                            {preview.totals.documents} documents
                            {preview.kind === "vyapar_register" &&
                                ` · ${preview.totals.update} update · ${preview.totals.create} new · ${preview.totals.cancelled} cancelled · ${preview.totals.lines} lines · ${preview.totals.batteries} batteries`}
                        </p>
                        <p>
                            Columns read:{" "}
                            {Object.entries(preview.columns)
                                .map(([f, h]) => `${f} ← "${h}"`)
                                .join(", ")}
                        </p>
                        {preview.unknown_columns.length > 0 && <p>Not used: {preview.unknown_columns.join(", ")}</p>}
                        {preview.unmapped_items.length > 0 && (
                            <p className="text-amber-700">
                                {preview.unmapped_items.length} item name(s) not mapped to a CRM product yet — map them on the Item
                                mapping tab after importing.
                            </p>
                        )}
                    </div>
                    <div className="max-h-96 overflow-auto rounded-md border border-border">
                        <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-surface-subtle text-left text-ink-muted">
                                <tr>
                                    <th className="px-2 py-1.5">Number</th>
                                    <th className="px-2 py-1.5">Date</th>
                                    <th className="px-2 py-1.5">Party</th>
                                    <th className="px-2 py-1.5">GSTIN</th>
                                    <th className="px-2 py-1.5 text-right">Lines</th>
                                    <th className="px-2 py-1.5 text-right">Batteries</th>
                                    <th className="px-2 py-1.5 text-right">Before GST</th>
                                    <th className="px-2 py-1.5">Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {preview.rows.slice(0, 300).map((r) => (
                                    <tr key={r.number} className="border-t border-border">
                                        <td className="px-2 py-1 font-mono">{r.number}</td>
                                        <td className="px-2 py-1">{r.date ?? "—"}</td>
                                        <td className="px-2 py-1">{r.party ?? "—"}</td>
                                        <td className="px-2 py-1 font-mono">{r.gstin ?? "—"}</td>
                                        <td className="px-2 py-1 text-right">{r.lines}</td>
                                        <td className="px-2 py-1 text-right">{r.batteries}</td>
                                        <td className="px-2 py-1 text-right">{inr(r.taxable)}</td>
                                        <td className="px-2 py-1">
                                            {r.cancelled ? <span className="text-rose-700">void (cancelled)</span> : r.doc_type === "credit_note" ? "credit note" : r.action}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <Button disabled={send.isPending || preview.totals.documents === 0} onClick={() => send.mutate("commit")}>
                        {send.isPending && send.variables === "commit" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Import {preview.totals.documents} documents
                    </Button>
                </div>
            )}

            <div>
                <h3 className="text-sm font-semibold text-ink">Recent imports</h3>
                {history.isLoading ? (
                    <p className="text-xs text-ink-muted mt-2">Loading…</p>
                ) : history.error ? (
                    <p className="text-xs text-red-600 mt-2">{(history.error as Error).message}</p>
                ) : (
                    <ul className="mt-2 divide-y divide-border text-xs">
                        {(history.data?.imports ?? []).map((i) => (
                            <li key={i.id} className="py-1.5 flex flex-wrap gap-x-3">
                                <span className="font-medium">{i.kind === "gstr1" ? "GSTR-1" : "Sales register"}</span>
                                <span>{i.file_name ?? "—"}</span>
                                <span className="text-ink-muted">
                                    {i.period_from?.slice(0, 10) ?? "?"} → {i.period_to?.slice(0, 10) ?? "?"}
                                </span>
                                <span className="text-ink-muted">{i.summary?.documents ?? 0} docs</span>
                                <span className="text-ink-muted">
                                    {new Date(i.created_at).toLocaleString("en-IN")} · {i.imported_by ?? "—"}
                                </span>
                            </li>
                        ))}
                        {(history.data?.imports ?? []).length === 0 && <li className="py-2 text-ink-muted">No imports yet.</li>}
                    </ul>
                )}
            </div>
        </div>
    );
}

// ── Item mapping ────────────────────────────────────────────────────────────

type ItemsPayload = {
    items: Array<{ item_key: string; item_name: string; lines: number; units: number; product_class: string | null; asset_type: string | null; product_id: string | null }>;
    products: Array<{ asset_type: string; product_id: string; product_name: string; model_id: string | null }>;
};

function ItemsTab() {
    const qc = useQueryClient();
    const q = useQuery({
        queryKey: ["invoice-ledger-items"],
        queryFn: async () => readData<ItemsPayload>(await fetch("/api/admin/sales-invoices/ledger/items"), "Could not load items"),
    });
    const map = useMutation({
        mutationFn: async (args: { item_name: string; value: string }) => {
            const [asset_type, product_id] = args.value ? args.value.split("|") : [null, null];
            return readData<{ lines_updated: number }>(
                await fetch("/api/admin/sales-invoices/ledger/items", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ item_name: args.item_name, asset_type, product_id }),
                }),
                "Could not save the mapping",
            );
        },
        onSuccess: (d) => {
            toast.success(`Saved — ${d.lines_updated} line(s) updated.`);
            qc.invalidateQueries({ queryKey: ["invoice-ledger-items"] });
        },
        onError: (e) => toast.error((e as Error).message),
    });

    if (q.isLoading) return <p className="text-sm text-ink-muted">Loading…</p>;
    if (q.error || !q.data) return <p className="text-sm text-red-600">{(q.error as Error)?.message}</p>;
    const unmapped = q.data.items.filter((i) => !i.product_id).length;

    return (
        <div className="space-y-3">
            <p className="text-xs text-ink-muted">
                Vyapar names items freely; map each to a CRM product so units are counted per SKU. {unmapped} unmapped.
            </p>
            <table className="w-full text-xs">
                <thead className="text-left text-ink-muted">
                    <tr>
                        <th className="py-1.5">Vyapar item</th>
                        <th className="py-1.5">Class (HSN)</th>
                        <th className="py-1.5 text-right">Lines</th>
                        <th className="py-1.5 text-right">Units</th>
                        <th className="py-1.5">CRM product</th>
                    </tr>
                </thead>
                <tbody>
                    {q.data.items.map((i) => (
                        <tr key={i.item_key} className="border-t border-border">
                            <td className="py-1.5">{i.item_name}</td>
                            <td className="py-1.5">{i.product_class ?? "—"}</td>
                            <td className="py-1.5 text-right">{i.lines}</td>
                            <td className="py-1.5 text-right">{i.units}</td>
                            <td className="py-1.5">
                                <select
                                    className="rounded-md border border-border bg-surface px-2 py-1 text-xs max-w-[22rem]"
                                    value={i.product_id ? `${i.asset_type}|${i.product_id}` : ""}
                                    disabled={map.isPending}
                                    onChange={(e) => map.mutate({ item_name: i.item_name, value: e.target.value })}
                                >
                                    <option value="">— not mapped —</option>
                                    {q.data.products.map((p) => (
                                        <option key={`${p.asset_type}|${p.product_id}`} value={`${p.asset_type}|${p.product_id}`}>
                                            {p.asset_type}: {p.product_name}
                                            {p.model_id ? ` (${p.model_id})` : ""}
                                        </option>
                                    ))}
                                </select>
                            </td>
                        </tr>
                    ))}
                    {q.data.items.length === 0 && (
                        <tr>
                            <td colSpan={5} className="py-4 text-center text-ink-muted">
                                No invoice lines yet — import a Vyapar sales register first.
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

// ── By SKU ──────────────────────────────────────────────────────────────────

function SkuTab() {
    const today = new Date().toISOString().slice(0, 10);
    const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
    const [to, setTo] = useState(today);
    const q = useQuery({
        queryKey: ["invoice-ledger-sku", from, to],
        queryFn: async () =>
            readData<{ available: boolean; rows: Array<{ month: string; product_class: string; sku: string; mapped: boolean; quantity: number; amount_excl_gst: number; invoices: number }> }>(
                await fetch(`/api/admin/sales-invoices/ledger/sku?from=${from}&to=${to}`),
                "Could not load the SKU report",
            ),
    });
    const totals = useMemo(() => {
        const rows = q.data?.rows ?? [];
        return {
            batteries: rows.filter((r) => r.product_class === "battery").reduce((s, r) => s + r.quantity, 0),
            amount: rows.reduce((s, r) => s + r.amount_excl_gst, 0),
        };
    }, [q.data]);

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3 text-xs">
                <label>
                    From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="ml-1 rounded-md border border-border px-2 py-1" />
                </label>
                <label>
                    To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="ml-1 rounded-md border border-border px-2 py-1" />
                </label>
                <span className="text-ink-muted">
                    {totals.batteries} batteries · {inr(totals.amount)} before GST
                </span>
            </div>
            {q.isLoading ? (
                <p className="text-sm text-ink-muted">Loading…</p>
            ) : q.error ? (
                <p className="text-sm text-red-600">{(q.error as Error).message}</p>
            ) : (
                <table className="w-full text-xs">
                    <thead className="text-left text-ink-muted">
                        <tr>
                            <th className="py-1.5">Month</th>
                            <th className="py-1.5">Class</th>
                            <th className="py-1.5">SKU</th>
                            <th className="py-1.5 text-right">Units</th>
                            <th className="py-1.5 text-right">Amount excl. GST</th>
                            <th className="py-1.5 text-right">Invoices</th>
                        </tr>
                    </thead>
                    <tbody>
                        {(q.data?.rows ?? []).map((r) => (
                            <tr key={`${r.month}|${r.product_class}|${r.sku}|${r.mapped}`} className="border-t border-border">
                                <td className="py-1.5">{r.month}</td>
                                <td className="py-1.5">{r.product_class}</td>
                                <td className="py-1.5">
                                    {r.sku}
                                    {!r.mapped && <span className="ml-1 text-amber-700">(unmapped)</span>}
                                </td>
                                <td className="py-1.5 text-right tabular-nums">{r.quantity}</td>
                                <td className="py-1.5 text-right tabular-nums">{inr(r.amount_excl_gst)}</td>
                                <td className="py-1.5 text-right tabular-nums">{r.invoices}</td>
                            </tr>
                        ))}
                        {(q.data?.rows ?? []).length === 0 && (
                            <tr>
                                <td colSpan={6} className="py-4 text-center text-ink-muted">
                                    No invoice lines in this window.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            )}
        </div>
    );
}

// ── GSTR-1 reconciliation ───────────────────────────────────────────────────

type Recon = {
    month: string;
    gstr1_loaded: boolean;
    crm_total: number;
    gstr1_total: number;
    difference: number;
    matched: number;
    missing_in_crm: Array<{ number: string; date: string | null; total: number }>;
    missing_in_gstr1: Array<{ number: string; date: string | null; total: number; customer?: string | null }>;
    amount_mismatch: Array<{ number: string; crm: number; gstr1: number; difference: number }>;
};

function ReconTab() {
    const ist = new Date(Date.now() + 330 * 60_000);
    const last = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const [month, setMonth] = useState(last);
    const q = useQuery({
        queryKey: ["invoice-ledger-recon", month],
        queryFn: async () =>
            readData<Recon>(await fetch(`/api/admin/sales-invoices/ledger/reconciliation?month=${month}`), "Could not reconcile"),
    });
    const d = q.data;
    return (
        <div className="space-y-4">
            <label className="text-xs">
                Month <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="ml-1 rounded-md border border-border px-2 py-1" />
            </label>
            {q.isLoading ? (
                <p className="text-sm text-ink-muted">Loading…</p>
            ) : q.error || !d ? (
                <p className="text-sm text-red-600">{(q.error as Error)?.message}</p>
            ) : (
                <>
                    {!d.gstr1_loaded && (
                        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                            No GSTR-1 imported for {d.month}. Import the filed return on the Import tab.
                        </p>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                        <Stat label="CRM revenue (incl. GST)" value={inr(d.crm_total)} />
                        <Stat label="GSTR-1 filed" value={inr(d.gstr1_total)} />
                        <Stat label="Difference" value={inr(d.difference)} tone={Math.abs(d.difference) > 1 ? "bad" : "good"} />
                        <Stat label="Documents agreeing" value={String(d.matched)} />
                    </div>
                    <DiffList title="In GSTR-1, not in the CRM" rows={d.missing_in_crm.map((r) => [r.number, r.date ?? "—", inr(r.total)])} />
                    <DiffList title="In the CRM, not in GSTR-1" rows={d.missing_in_gstr1.map((r) => [r.number, r.date ?? "—", inr(r.total)])} />
                    <DiffList
                        title="Amounts that disagree (CRM · GSTR-1 · difference)"
                        rows={d.amount_mismatch.map((r) => [r.number, `${inr(r.crm)} · ${inr(r.gstr1)}`, inr(r.difference)])}
                    />
                </>
            )}
        </div>
    );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
    return (
        <div className="rounded-lg border border-border px-3 py-2">
            <div className="text-[11px] text-ink-muted">{label}</div>
            <div className={`text-base font-semibold tabular-nums ${tone === "bad" ? "text-rose-700" : tone === "good" ? "text-emerald-700" : "text-ink"}`}>
                {value}
            </div>
        </div>
    );
}

function DiffList({ title, rows }: { title: string; rows: string[][] }) {
    return (
        <div>
            <h4 className="text-xs font-semibold text-ink">
                {title} — {rows.length}
            </h4>
            {rows.length > 0 && (
                <ul className="mt-1 max-h-60 overflow-auto divide-y divide-border text-xs">
                    {rows.map((r) => (
                        <li key={r.join("|")} className="py-1 flex gap-3">
                            <span className="font-mono">{r[0]}</span>
                            <span className="text-ink-muted">{r[1]}</span>
                            <span className="ml-auto tabular-nums">{r[2]}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
