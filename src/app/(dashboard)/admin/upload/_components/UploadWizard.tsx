"use client";

// BRD §0.4 — the 4-step upload wizard: choose file → validate → set options →
// confirm import. Accepts a CSV or an Excel (.xlsx/.xls) file; an Excel file
// is converted to CSV in the browser so the server side stays CSV-only.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import {
    CheckCircle2,
    Loader2,
    Upload as UploadIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
    UploadBatchSummary,
    UploadRowResult,
    UploadValidationResult,
} from "@/lib/admin/types";

const MAX_BYTES = 5 * 1024 * 1024;

const STATUS_STYLE: Record<string, string> = {
    valid: "bg-success-bg text-success border-success/30",
    reactivate: "bg-brand-50 text-brand-700 border-brand-200",
    duplicate_skip: "bg-bg text-ink-muted border-border",
    address_mismatch: "bg-warning-bg text-warning border-warning/30",
    error: "bg-danger-bg text-danger border-danger/30",
};

export function UploadWizard() {
    const qc = useQueryClient();
    const [fileName, setFileName] = useState("");
    const [csvText, setCsvText] = useState("");
    const [validation, setValidation] = useState<UploadValidationResult | null>(
        null,
    );
    const [routingToAi, setRoutingToAi] = useState(false);
    const [sourceLabel, setSourceLabel] = useState("");
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<UploadBatchSummary | null>(null);

    function reset() {
        setFileName("");
        setCsvText("");
        setValidation(null);
        setRoutingToAi(false);
        setSourceLabel("");
        setResult(null);
    }

    async function onFile(file: File | null) {
        if (!file) return;
        if (file.size > MAX_BYTES) {
            toast.error("File exceeds the 5 MB limit.");
            return;
        }
        let text: string;
        const name = file.name.toLowerCase();
        try {
            if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
                // Excel — convert the first sheet to CSV in the browser.
                const buf = await file.arrayBuffer();
                const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
                const sheetName = wb.SheetNames[0];
                const ws = sheetName ? wb.Sheets[sheetName] : undefined;
                if (!ws) {
                    toast.error("That Excel file has no readable sheet.");
                    return;
                }
                text = XLSX.utils.sheet_to_csv(ws);
            } else {
                text = await file.text();
            }
        } catch {
            toast.error("Could not read that file. Use a .csv or .xlsx file.");
            return;
        }
        setFileName(file.name);
        setCsvText(text);
        setValidation(null);
        setResult(null);
    }

    async function validate() {
        setBusy(true);
        try {
            const res = await fetch("/api/admin/upload/validate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ file_name: fileName, csv_text: csvText }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Validation failed");
            }
            setValidation(json.data);
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function commit() {
        setBusy(true);
        try {
            const res = await fetch("/api/admin/upload/commit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    file_name: fileName,
                    csv_text: csvText,
                    routing_to_ai: routingToAi,
                    source_label: sourceLabel.trim() || null,
                }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Import failed");
            }
            setResult(json.data);
            toast.success("Import complete.");
            qc.invalidateQueries({ queryKey: ["admin-upload-batches"] });
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    // ── Done state ─────────────────────────────────────────────────────────
    if (result) {
        return (
            <div className="rounded-xl border border-success/30 bg-success-bg/50 shadow-card p-6">
                <div className="flex items-center gap-2 text-success">
                    <CheckCircle2 className="h-5 w-5" />
                    <h2 className="text-base font-semibold">Import complete</h2>
                </div>
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                    <Stat label="Total rows" value={result.total_rows} />
                    <Stat label="Imported" value={result.valid_rows} />
                    <Stat label="Duplicates" value={result.duplicate_rows} />
                    <Stat label="Errors" value={result.errored_rows} />
                </div>
                <p className="mt-3 text-xs text-ink-muted">
                    Batch {result.batch_id} — can be rolled back for 24 hours
                    (see Recent Batches below).
                </p>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={reset}
                >
                    Upload another file
                </Button>
            </div>
        );
    }

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card p-6 space-y-5">
            {/* Step 1 — file */}
            <div>
                <label className="inline-flex items-center gap-2 cursor-pointer rounded-lg border border-dashed border-border px-4 py-3 hover:bg-bg transition">
                    <UploadIcon className="h-4 w-4 text-ink-muted" />
                    <span className="text-sm text-ink-muted">
                        {fileName || "Choose a CSV or Excel file…"}
                    </span>
                    <input
                        type="file"
                        accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                        className="hidden"
                        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
                    />
                </label>
                {fileName && !validation && (
                    <Button
                        type="button"
                        size="sm"
                        className="ml-3"
                        onClick={validate}
                        disabled={busy}
                    >
                        {busy && (
                            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                        )}
                        Validate
                    </Button>
                )}
            </div>

            {/* Step 2 — validation preview */}
            {validation && (
                <>
                    {validation.headers.missing_required.length > 0 && (
                        <div className="rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger">
                            Missing required column
                            {validation.headers.missing_required.length > 1
                                ? "s"
                                : ""}
                            : {validation.headers.missing_required.join(", ")}.
                            Add {validation.headers.missing_required.length > 1
                                ? "them"
                                : "it"}{" "}
                            and re-upload.
                        </div>
                    )}
                    {validation.headers.ignored.length > 0 && (
                        <div className="rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning">
                            Ignored column
                            {validation.headers.ignored.length > 1 ? "s" : ""}:{" "}
                            {validation.headers.ignored.join(", ")} — not
                            recognized, so skipped. The rest will still import.
                        </div>
                    )}

                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                        <Stat label="Total" value={validation.total_rows} />
                        <Stat label="New" value={validation.valid_rows} />
                        <Stat label="Reactivate" value={validation.reactivate_rows} />
                        <Stat
                            label="Duplicates"
                            value={
                                validation.duplicate_rows +
                                validation.address_mismatch_rows
                            }
                        />
                        <Stat label="Errors" value={validation.errored_rows} />
                    </div>

                    <div className="rounded-lg border border-border max-h-72 overflow-y-auto">
                        <table className="w-full text-xs">
                            <thead className="bg-bg/60 text-[10px] uppercase tracking-wide text-ink-muted sticky top-0">
                                <tr>
                                    <th className="text-left px-3 py-2">Row</th>
                                    <th className="text-left px-3 py-2">Dealer</th>
                                    <th className="text-left px-3 py-2">Phone</th>
                                    <th className="text-left px-3 py-2">Owner</th>
                                    <th className="text-left px-3 py-2">Status</th>
                                    <th className="text-left px-3 py-2">Notes</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {validation.rows.map((r: UploadRowResult) => (
                                    <tr key={r.row_number}>
                                        <td className="px-3 py-1.5 text-ink-muted">
                                            {r.row_number}
                                        </td>
                                        <td className="px-3 py-1.5 text-ink">
                                            {r.dealer_name || "—"}
                                        </td>
                                        <td className="px-3 py-1.5 text-ink-muted tabular-nums">
                                            {r.normalized_phone || "—"}
                                        </td>
                                        <td className="px-3 py-1.5 text-ink">
                                            {r.assigned_owner_name || "—"}
                                        </td>
                                        <td className="px-3 py-1.5">
                                            <span
                                                className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold border ${
                                                    STATUS_STYLE[r.status] ??
                                                    STATUS_STYLE.error
                                                }`}
                                            >
                                                {r.status}
                                            </span>
                                        </td>
                                        <td className="px-3 py-1.5 text-ink-muted">
                                            {r.errors.length > 0
                                                ? r.errors.join("; ")
                                                : r.location_suggestion
                                                  ? `Did you mean ${r.location_suggestion}?`
                                                  : "—"}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Step 3 — options */}
                    <div className="flex flex-wrap items-end gap-4 rounded-lg bg-bg/60 border border-border p-3">
                        <label className="flex items-center gap-2 text-sm text-ink">
                            <input
                                type="checkbox"
                                checked={routingToAi}
                                onChange={(e) =>
                                    setRoutingToAi(e.target.checked)
                                }
                            />
                            Route through AI dialer first
                        </label>
                        <p className="w-full text-[11px] text-ink-muted">
                            Rows with an <span className="font-medium">assignee</span> go
                            straight to that rep/ASM&apos;s queue and skip the AI dialer.
                        </p>
                        <div>
                            <label className="block text-[10px] font-medium uppercase tracking-wide text-ink-muted mb-1">
                                Source label (optional)
                            </label>
                            <Input
                                value={sourceLabel}
                                onChange={(e) => setSourceLabel(e.target.value)}
                                placeholder="e.g. Auto Expo 2026"
                                className="h-9 w-56"
                            />
                        </div>
                        <Button
                            type="button"
                            className="ml-auto"
                            onClick={commit}
                            disabled={
                                busy ||
                                validation.valid_rows +
                                    validation.reactivate_rows ===
                                    0
                            }
                        >
                            {busy && (
                                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                            )}
                            Confirm &amp; Import
                        </Button>
                    </div>
                </>
            )}
        </div>
    );
}

function Stat({ label, value }: { label: string; value: number }) {
    return (
        <div className="rounded-lg border border-border bg-surface px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                {label}
            </div>
            <div className="text-lg font-semibold tabular-nums text-ink">
                {value}
            </div>
        </div>
    );
}
