"use client";

// Vyapar payment sync on CEO › Receivables: upload the weekly Vyapar Sale
// Report, preview what it changes (receivable before → after, each invoice's
// paid and owed before → after, customers whose balance moves), then import.
// Same endpoint as Invoice Ledger › Import; nothing is written until Import.

import { InfoTip } from "@/components/ui/info-tip";
import { Fragment, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, CheckCircle2, FileSpreadsheet, Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";

type Change = "none" | "increase" | "decrease" | "no_data";

type PreviewRow = {
    number: string;
    date: string | null;
    party: string | null;
    doc_type: string;
    cancelled: boolean;
    action: string;
    existing_id: string | null;
    crm_total?: number | null;
    register_total?: number | null;
    paid_before?: number | null;
    paid_after?: number | null;
    balance_after?: number | null;
    payment_change?: Change;
    total_mismatch?: boolean;
    overrides_manual?: boolean;
    already_void?: boolean;
    /** new | duplicate (skipped, nothing written) | updated — against the last import and the CRM. */
    classification?: "new" | "duplicate" | "updated";
    changes?: Array<"amount" | "received" | "balance" | "date" | "lines" | "cancelled">;
    drift?: Array<"amount" | "paid" | "date" | "cancelled" | "lines">;
    crm_date?: string | null;
    total_after?: number | null;
};

type Preview = {
    period: { from: string | null; to: string | null };
    warnings: string[];
    totals: {
        documents: number;
        update: number;
        create: number;
        in_zoho?: number;
        cancelled: number;
        new_docs?: number;
        updated_docs?: number;
        duplicates?: number;
    };
    rows: PreviewRow[];
    payments?: {
        generated_at: string | null;
        last_generated_at: string | null;
        older_than_last: boolean;
        increases: number;
        decreases: number;
        collected: number;
        open_balance: number;
        total_mismatches: number;
        not_in_file: Array<{ number: string; party: string | null; date: string | null; balance: number }>;
        not_in_file_balance: number;
        before_period: { count: number; balance: number; oldest: string | null };
    } | null;
    receivable?: {
        before: number;
        after: number;
        customers: Array<{ owe_key: string; name: string | null; before: number; after: number }>;
    } | null;
};

const rupees = (n: number) => `${n < 0 ? "−" : ""}₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const inr = (n: number) =>
    Math.abs(n) >= 1e7
        ? `${n < 0 ? "−" : ""}₹${(Math.abs(n) / 1e7).toFixed(2)} Cr`
        : Math.abs(n) >= 1e5
          ? `${n < 0 ? "−" : ""}₹${(Math.abs(n) / 1e5).toFixed(2)} L`
          : rupees(Math.round(n));
const fmtDate = (d: string | null) =>
    d
        ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })
        : "—";
const istStamp = (iso: string | null | undefined) =>
    iso
        ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })
        : "—";

async function readData<T>(res: Response, fallback: string): Promise<T> {
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) throw new Error(body?.error?.message ?? fallback);
    return body.data as T;
}

/** "₹6.00 L → ₹3.00 L", with the new value emphasised; one value when nothing moves. */
function BeforeAfter({ before, after, tone }: { before: number; after: number; tone?: "good" | "bad" }) {
    if (Math.abs(before - after) < 0.5) return <span className="tabular-nums text-gray-700">{rupees(after)}</span>;
    const color = tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-rose-700" : "text-gray-900";
    return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums">
            <span className="text-gray-400 line-through decoration-gray-300">{rupees(before)}</span>
            <ArrowRight className="h-3 w-3 text-gray-400" />
            <span className={`font-semibold ${color}`}>{rupees(after)}</span>
        </span>
    );
}

function ChangeBadge({ r }: { r: PreviewRow }) {
    if (r.cancelled)
        return (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                {r.already_void ? "Cancelled · already void" : "Cancelled → void"}
            </span>
        );
    if (r.action === "in_zoho") return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">Zoho invoice · skipped</span>;
    if (r.classification === "duplicate")
        return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">Duplicate · skipped</span>;
    if (r.doc_type === "credit_note")
        return (
            <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-700">
                {r.classification === "new" ? "New credit note" : "Credit note updated"}
            </span>
        );
    if (r.classification === "new") return <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-700">New invoice</span>;
    switch (r.payment_change) {
        case "increase":
            return (r.balance_after ?? 0) <= 0.5 ? (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">Now paid</span>
            ) : (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">Part payment</span>
            );
        case "decrease":
            return <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700">Paid went down</span>;
        case "no_data":
            return <span className="text-xs text-gray-500">No payment in file</span>;
        default:
            if (r.classification === "updated")
                return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">Updated</span>;
            return <span className="text-xs text-gray-500">No change</span>;
    }
}

/** What an updated invoice gets from Vyapar, as small chips under its badge. */
function ChangeChips({ r }: { r: PreviewRow }) {
    if (r.classification !== "updated") return null;
    const changes = r.changes ?? [];
    const drift = r.drift ?? [];
    const chips: Array<{ text: string; tone: "amber" | "gray" | "rose" }> = [];
    if ((changes.includes("amount") || drift.includes("amount")) && r.register_total != null) {
        chips.push({
            text: `Amount ${r.crm_total != null ? rupees(r.crm_total) : "—"} → ${rupees(r.register_total)}`,
            tone: "amber",
        });
    }
    if ((changes.includes("date") || drift.includes("date")) && r.date) {
        chips.push({ text: `Date ${fmtDate(r.crm_date ?? null)} → ${fmtDate(r.date)}`, tone: "amber" });
    }
    if (changes.includes("lines") || drift.includes("lines")) chips.push({ text: "Items updated", tone: "gray" });
    if (drift.includes("paid") && !changes.includes("received") && !changes.includes("balance")) {
        chips.push({ text: "CRM payment reset to Vyapar", tone: "rose" });
    }
    if (!chips.length) return null;
    const cls = { amber: "bg-amber-50 text-amber-800", gray: "bg-gray-100 text-gray-700", rose: "bg-rose-50 text-rose-700" };
    return (
        <span className="mt-1 flex flex-wrap gap-1">
            {chips.map((c) => (
                <span key={c.text} className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${cls[c.tone]}`}>
                    {c.text}
                </span>
            ))}
        </span>
    );
}

export default function VyaparPaymentUpload() {
    const router = useRouter();
    const input = useRef<HTMLInputElement>(null);
    const [open, setOpen] = useState(false);
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [view, setView] = useState<"changes" | "all">("changes");

    const reset = () => {
        setFile(null);
        setPreview(null);
        setError(null);
        setView("changes");
        if (input.current) input.current.value = "";
    };

    async function send(mode: "preview" | "commit") {
        if (!file) return;
        setBusy(mode);
        setError(null);
        try {
            const fd = new FormData();
            fd.append("file", file);
            fd.append("kind", "vyapar_register");
            fd.append("mode", mode);
            const res = await fetch("/api/admin/sales-invoices/ledger/import", { method: "POST", body: fd });
            if (mode === "preview") {
                const data = await readData<{ preview: Preview }>(res, "Could not read the file");
                setPreview(data.preview);
                setView("changes");
                return;
            }
            const data = await readData<{ summary: Record<string, number> }>(res, "Import failed");
            const s = data.summary ?? {};
            const parts = [
                s.created_ids ? `${s.created_ids} new` : null,
                s.updated_existing ? `${s.updated_existing} updated` : null,
                s.skipped_duplicates ? `${s.skipped_duplicates} duplicates skipped` : null,
            ].filter(Boolean);
            toast.success(
                `Imported${parts.length ? `: ${parts.join(", ")}` : ""}.` +
                    (s.payments_set ? ` Payments changed on ${s.payments_set} (${inr(s.collected ?? 0)} newly collected).` : ""),
            );
            reset();
            setOpen(false);
            router.refresh();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(null);
        }
    }

    if (!open) {
        return (
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-50"
            >
                <Upload className="h-4 w-4" /> Update payments from Vyapar
            </button>
        );
    }

    const p = preview?.payments ?? null;
    const recv = preview?.receivable ?? null;
    const synced = (preview?.rows ?? []).filter((r) => r.doc_type === "invoice");
    const classified = (preview?.rows ?? []).some((r) => r.classification);
    const changed = (preview?.rows ?? []).filter((r) =>
        classified
            ? r.classification === "new" || r.classification === "updated"
            : r.payment_change === "increase" ||
              r.payment_change === "decrease" ||
              (r.cancelled && !r.already_void) ||
              (r.action === "create" && r.doc_type === "invoice") ||
              r.total_mismatch,
    );
    const counts = {
        new: preview?.totals.new_docs ?? 0,
        updated: preview?.totals.updated_docs ?? 0,
        duplicates: preview?.totals.duplicates ?? 0,
    };
    const nothingToDo = classified && counts.new + counts.updated === 0;
    const shown = view === "changes" ? changed : (preview?.rows ?? []);
    const flagged = (p?.not_in_file.length ?? 0) + (p?.before_period.count ?? 0);
    // ID 200 d (Kartik, 4 Nov): an older export is refused, no override.
    const blocked = !!p?.older_than_last;

    const pill = (k: "changes" | "all", text: string, n: number) => (
        <button
            type="button"
            onClick={() => setView(k)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                view === k ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
            }`}
        >
            {text} · {n}
        </button>
    );

    return (
        <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h2 className="text-sm font-semibold text-gray-900">Update payments from Vyapar</h2>
                    <p className="mt-0.5 text-xs text-gray-500">
                        Upload the Vyapar <span className="font-medium text-gray-700">Sale Report</span>; preview first, nothing is saved until you import.
                        <InfoTip className="ml-1">
                            {"In Vyapar: Reports › Sale Report › Excel, from the start of the financial year. Each invoice's paid amount is set to what Vyapar has received so far, so uploading the same file again changes nothing."}
                        </InfoTip>
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => {
                        reset();
                        setOpen(false);
                    }}
                    className="rounded-lg p-1 text-gray-400 hover:bg-gray-50 hover:text-gray-700"
                    aria-label="Close"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                    <FileSpreadsheet className="h-4 w-4 text-emerald-700" />
                    <span className="max-w-xs truncate">{file ? file.name : "Choose Excel file"}</span>
                    <input
                        ref={input}
                        type="file"
                        accept=".xlsx,.xls"
                        className="hidden"
                        onChange={(e) => {
                            setFile(e.target.files?.[0] ?? null);
                            setPreview(null);
                            setError(null);
                        }}
                    />
                </label>
                <button
                    type="button"
                    disabled={!file || busy !== null}
                    onClick={() => send("preview")}
                    className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {busy === "preview" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    Preview
                </button>
                {file && (
                    <button type="button" onClick={reset} className="text-xs font-semibold text-brand-sky hover:underline">
                        Clear
                    </button>
                )}
            </div>

            {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

            {preview && !p && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    This file has no Received / Balance Due columns, so it cannot update payments. Export the Vyapar <strong>Sale Report</strong>{" "}
                    (both sheets), not the item-wise report.
                </p>
            )}

            {preview && p && (
                <div className="space-y-4">
                    <p className="text-xs text-gray-500">
                        Vyapar export of <span className="font-semibold text-gray-700">{istStamp(p.generated_at)}</span> · invoices{" "}
                        {fmtDate(preview.period.from)} to {fmtDate(preview.period.to)} · {preview.totals.documents} documents
                        {p.last_generated_at && <> · last import was the export of {istStamp(p.last_generated_at)}</>}
                    </p>

                    {classified && (
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 font-semibold text-sky-800">{counts.new} new</span>
                            <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 font-semibold text-amber-800">
                                {counts.updated} updated
                            </span>
                            <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 font-semibold text-gray-700">
                                {counts.duplicates} duplicate{counts.duplicates === 1 ? "" : "s"} · skipped
                            </span>
                            <span className="text-gray-500">
                                Duplicates are invoices with the same number, date, amount and payments as the last import — nothing is written for them.
                            </span>
                        </div>
                    )}

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <div className="rounded-xl border border-gray-200 bg-white p-4">
                            <p className="text-xs font-semibold text-gray-500">Receivable</p>
                            {recv ? (
                                <>
                                    <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xl font-bold text-brand-navy">
                                        {Math.abs(recv.before - recv.after) >= 0.5 && (
                                            <span className="text-base font-semibold text-gray-400 line-through decoration-gray-300">{inr(recv.before)}</span>
                                        )}
                                        <span>{inr(recv.after)}</span>
                                    </p>
                                    <p className="text-xs text-gray-500">
                                        {Math.abs(recv.before - recv.after) < 0.5
                                            ? "No change after import"
                                            : `${recv.after < recv.before ? "Down" : "Up"} ${inr(Math.abs(recv.before - recv.after))} after import`}
                                    </p>
                                </>
                            ) : (
                                <p className="mt-1 text-sm text-gray-500">Could not work out the new total.</p>
                            )}
                        </div>
                        <div className="rounded-xl border border-gray-200 bg-white p-4">
                            <p className="text-xs font-semibold text-gray-500">Newly collected</p>
                            <p className="mt-1 text-xl font-bold text-emerald-700">{inr(p.collected)}</p>
                            <p className="text-xs text-gray-500">Payments in Vyapar not yet in the CRM</p>
                        </div>
                        <div className="rounded-xl border border-gray-200 bg-white p-4">
                            <p className="text-xs font-semibold text-gray-500">Invoices updated</p>
                            <p className="mt-1 text-xl font-bold text-brand-navy">{classified ? counts.updated : p.increases + p.decreases}</p>
                            <p className="text-xs text-gray-500">
                                {p.increases} paid more{p.decreases ? ` · ${p.decreases} paid less` : ""}
                                {classified ? ` · ${counts.new} new · ${counts.duplicates} duplicates` : ` · ${synced.length} in file`}
                            </p>
                        </div>
                        <div className="rounded-xl border border-gray-200 bg-white p-4">
                            <p className="text-xs font-semibold text-gray-500">Needs a look</p>
                            <p className={`mt-1 text-xl font-bold ${flagged ? "text-amber-700" : "text-brand-navy"}`}>{flagged}</p>
                            <p className="text-xs text-gray-500">Open invoices missing from this file, or older than it</p>
                        </div>
                    </div>

                    {p.older_than_last && (
                        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                            <p className="flex items-center gap-2 font-semibold">
                                <AlertTriangle className="h-4 w-4" /> This export is older than the last one imported ({istStamp(p.last_generated_at)}).
                            </p>
                            <p className="mt-0.5 text-xs">
                                It cannot be imported: it would set payments back to older figures. Export the Sale Report again from Vyapar and upload that.
                            </p>
                        </div>
                    )}

                    {(p.decreases > 0 || p.total_mismatches > 0 || p.before_period.count > 0 || p.not_in_file.length > 0 || preview.warnings.length > 0) && (
                        <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                            {p.decreases > 0 && (
                                <li>
                                    <span className="font-semibold">{p.decreases} invoice(s) show less paid in Vyapar than in the CRM</span> — a reversed
                                    or moved payment, or an amount typed in by hand. Vyapar wins.
                                </li>
                            )}
                            {p.total_mismatches > 0 && (
                                <li>
                                    <span className="font-semibold">{p.total_mismatches} invoice total(s) differ from Vyapar</span> — the CRM total
                                    (usually a misread PDF) is corrected to Vyapar&apos;s on import.
                                </li>
                            )}
                            {p.before_period.count > 0 && (
                                <li>
                                    <span className="font-semibold">
                                        {p.before_period.count} open invoice(s) ({inr(p.before_period.balance)}) are dated before this file starts
                                    </span>{" "}
                                    (oldest {fmtDate(p.before_period.oldest)}) — it cannot update them. Export from that date to include them.
                                </li>
                            )}
                            {p.not_in_file.length > 0 && (
                                <li>
                                    <span className="font-semibold">
                                        {p.not_in_file.length} open invoice(s) ({inr(p.not_in_file_balance)}) are in this period but not in the file
                                    </span>{" "}
                                    — left unchanged: {p.not_in_file.slice(0, 6).map((m) => m.number).join(", ")}
                                    {p.not_in_file.length > 6 ? "…" : ""}
                                </li>
                            )}
                            {preview.warnings.slice(0, 5).map((w) => (
                                <li key={w}>{w}</li>
                            ))}
                        </ul>
                    )}

                    {recv && recv.customers.length > 0 && (
                        <div className="space-y-2">
                            <h3 className="text-sm font-semibold text-gray-900">Customers whose balance changes</h3>
                            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                                <table className="min-w-full text-sm">
                                    <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                                        <tr>
                                            <th className="px-4 py-3">Dealer / customer</th>
                                            <th className="px-4 py-3 text-right">Receivable now</th>
                                            <th className="px-4 py-3 text-right">After import</th>
                                            <th className="px-4 py-3 text-right">Change</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                        {recv.customers.slice(0, 15).map((c) => (
                                            <tr key={c.owe_key}>
                                                <td className="px-4 py-3 text-gray-900">{c.name ?? "(no name)"}</td>
                                                <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600">{rupees(c.before)}</td>
                                                <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums text-gray-900">{rupees(c.after)}</td>
                                                <td
                                                    className={`whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums ${
                                                        c.after < c.before ? "text-emerald-700" : "text-rose-700"
                                                    }`}
                                                >
                                                    {c.after < c.before ? "−" : "+"}
                                                    {rupees(Math.abs(c.after - c.before))}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                    <tfoot className="bg-gray-50 text-sm font-semibold">
                                        <tr>
                                            <td className="px-4 py-3">Receivable (all customers)</td>
                                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600">{rupees(recv.before)}</td>
                                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-brand-navy">{rupees(recv.after)}</td>
                                            <td
                                                className={`whitespace-nowrap px-4 py-3 text-right tabular-nums ${
                                                    recv.after <= recv.before ? "text-emerald-700" : "text-rose-700"
                                                }`}
                                            >
                                                {recv.after <= recv.before ? "−" : "+"}
                                                {rupees(Math.abs(recv.after - recv.before))}
                                            </td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                            {recv.customers.length > 15 && (
                                <p className="text-xs text-gray-500">Top 15 of {recv.customers.length} customers whose balance changes.</p>
                            )}
                        </div>
                    )}

                    <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <h3 className="mr-2 text-sm font-semibold text-gray-900">Invoices</h3>
                            {pill("changes", "Changes", changed.length)}
                            {pill("all", "Everything in the file", preview.rows.length)}
                        </div>
                        {shown.length === 0 ? (
                            <p className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
                                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                Already up to date — every invoice in this export is a duplicate of the last import. Nothing to import.
                            </p>
                        ) : (
                            <div className="max-h-[32rem] overflow-auto rounded-xl border border-gray-200 bg-white">
                                <table className="min-w-full text-sm">
                                    <thead className="sticky top-0 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                                        <tr>
                                            <th className="px-4 py-3">Invoice</th>
                                            <th className="px-4 py-3">Customer on invoice</th>
                                            <th className="px-4 py-3 text-right">Invoice total</th>
                                            <th className="px-4 py-3 text-right">Paid (now → after)</th>
                                            <th className="px-4 py-3 text-right">Receivable (now → after)</th>
                                            <th className="px-4 py-3">Change</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                        {shown.map((r) => {
                                            const hasPay = r.crm_total != null && r.paid_after != null;
                                            const owedBefore = r.crm_total != null ? r.crm_total - (r.paid_before ?? 0) : null;
                                            return (
                                                <Fragment key={r.number}>
                                                    <tr className="align-top">
                                                        <td className="whitespace-nowrap px-4 py-3">
                                                            <span className="font-medium text-gray-900">{r.number}</span>
                                                            <span className="block text-xs text-gray-500">{fmtDate(r.date)}</span>
                                                        </td>
                                                        <td className="px-4 py-3 text-gray-800">{r.party ?? "—"}</td>
                                                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-600">
                                                            {r.crm_total != null && r.total_after != null ? (
                                                                <BeforeAfter before={r.crm_total} after={r.total_after} />
                                                            ) : r.crm_total != null ? (
                                                                rupees(r.crm_total)
                                                            ) : (
                                                                "—"
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-3 text-right">
                                                            {hasPay ? (
                                                                <BeforeAfter
                                                                    before={r.paid_before ?? 0}
                                                                    after={r.paid_after ?? 0}
                                                                    tone={r.payment_change === "decrease" ? "bad" : "good"}
                                                                />
                                                            ) : (
                                                                <span className="text-gray-400">—</span>
                                                            )}
                                                            {r.overrides_manual && <span className="block text-xs text-rose-700">was typed in by hand</span>}
                                                        </td>
                                                        <td className="px-4 py-3 text-right">
                                                            {hasPay && owedBefore != null && r.classification !== "duplicate" ? (
                                                                <BeforeAfter
                                                                    before={owedBefore}
                                                                    after={r.balance_after ?? owedBefore}
                                                                    tone={(r.balance_after ?? owedBefore) < owedBefore ? "good" : "bad"}
                                                                />
                                                            ) : (
                                                                <span className="text-gray-400">—</span>
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-3">
                                                            <ChangeBadge r={r} />
                                                            <ChangeChips r={r} />
                                                        </td>
                                                    </tr>
                                                </Fragment>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-100 pt-3">
                        <button
                            type="button"
                            onClick={reset}
                            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            disabled={busy !== null || blocked || nothingToDo}
                            onClick={() => send("commit")}
                            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {busy === "commit" && <Loader2 className="h-4 w-4 animate-spin" />}
                            {nothingToDo
                                ? "Nothing to import — all duplicates"
                                : classified
                                  ? `Import · ${counts.new} new, ${counts.updated} updated${counts.duplicates ? ` (${counts.duplicates} duplicates skipped)` : ""}`
                                  : p.increases + p.decreases > 0
                                    ? `Import · update ${p.increases + p.decreases} payment${p.increases + p.decreases === 1 ? "" : "s"}`
                                    : "Import"}
                        </button>
                    </div>
                </div>
            )}
        </section>
    );
}
