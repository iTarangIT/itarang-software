"use client";

// E-176 — bulk-upload manual/offline dealer sales (Excel/CSV) from the CEO
// dashboard. Parses client-side (like the leads importer), POSTs rows to
// /api/dashboard/ceo/manual-sales, then invalidates the dashboard + drill-down
// queries so the Sales-to-Dealer card/total reflect the new rows.
//
// Accepted columns (header names are matched case-insensitively, flexible):
//   sale_date | date           (required, any parseable date)
//   amount    | value          (required, number)
//   customer_name | customer
//   product_name  | product
//   quantity      | qty
//   invoice_number| invoice

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Upload, Loader2 } from "lucide-react";

type ManualRow = {
    sale_date: string;
    customer_name?: string | null;
    product_name?: string | null;
    quantity?: number | null;
    amount: number;
    invoice_number?: string | null;
};

function pick(row: Record<string, unknown>, keys: string[]): unknown {
    const lower: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) lower[k.trim().toLowerCase()] = v;
    for (const k of keys) {
        const v = lower[k];
        if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
    return undefined;
}

function toIsoDate(v: unknown): string | null {
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
        return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
    }
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    return null;
}

function toNumber(v: unknown): number | null {
    if (v === undefined || v === null || String(v).trim() === "") return null;
    const n = Number(String(v).replace(/[, ₹]/g, ""));
    return Number.isFinite(n) ? n : null;
}

export function ManualSalesUpload() {
    const qc = useQueryClient();
    const inputRef = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);

    const handleFile = async (file: File) => {
        setBusy(true);
        try {
            const XLSX = await import("xlsx");
            const buffer = await file.arrayBuffer();
            const wb = XLSX.read(buffer, { type: "array", cellDates: true });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });

            const rows: ManualRow[] = [];
            let skipped = 0;
            for (const r of raw) {
                const sale_date = toIsoDate(pick(r, ["sale_date", "date", "invoice_date"]));
                const amount = toNumber(pick(r, ["amount", "value", "total"]));
                if (!sale_date || amount === null) {
                    skipped++;
                    continue;
                }
                rows.push({
                    sale_date,
                    amount,
                    customer_name: (pick(r, ["customer_name", "customer", "dealer", "dealer_name"]) as string) ?? null,
                    product_name: (pick(r, ["product_name", "product", "item"]) as string) ?? null,
                    quantity: toNumber(pick(r, ["quantity", "qty", "units"])),
                    invoice_number: (pick(r, ["invoice_number", "invoice", "invoice_no", "bill_no"]) as string) ?? null,
                });
            }

            if (rows.length === 0) {
                toast.error("No valid rows — need at least a date and amount per row.");
                return;
            }

            const res = await fetch("/api/dashboard/ceo/manual-sales", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ rows }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Upload failed");

            toast.success(
                `Uploaded ${rows.length} sale${rows.length === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}.`,
            );
            qc.invalidateQueries({ queryKey: ["dashboard-metrics", "ceo"] });
            qc.invalidateQueries({ queryKey: ["ceo-drill-down", "sales"] });
        } catch (e) {
            toast.error("Failed: " + (e as Error).message);
        } finally {
            setBusy(false);
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    return (
        <>
            <button
                type="button"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
                title="Bulk-upload offline dealer sales (Excel/CSV with date + amount columns)"
                className="text-[11px] font-semibold text-brand-700 hover:underline flex items-center gap-1 disabled:opacity-50"
            >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                {busy ? "Uploading…" : "Upload sales"}
            </button>
            <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                }}
            />
        </>
    );
}
