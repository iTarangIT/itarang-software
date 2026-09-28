"use client";

// A filterable, exportable table for the small Ecofy queues that arrive fully
// loaded from Ecofy (Financing queue, Eligibility queue, Assets). The server
// page maps Ecofy's rows into plain cells; this component adds what the leads
// list already has — a search box, a Filters disclosure (one control per
// column plus a date range) and Download CSV — without a round trip: the
// queues are a few dozen rows, so filtering and the CSV happen in the browser.

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Download, RotateCcw, Search, SlidersHorizontal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { QUEUE_SELECT_CLASS, QueueFilterField } from "@/components/leads/QueueFilterBar";

export type QueueColumn = {
    key: string;
    label: string;
    /** "select" = a dropdown of the distinct values in the column; "text" = a contains box; omitted = not filterable. */
    filter?: "select" | "text";
    /** This column carries the row's date (ISO or YYYY-MM-DD in `cells[key].text`); the Filters panel gets From / To for it. */
    date?: boolean;
    mono?: boolean;
};

export type QueueCell = {
    /** What the filters, the search and the CSV see. */
    text: string;
    /** Second line under the text (city under the customer, file no. under the case). */
    sub?: string | null;
    /** Rendered instead of `text` when given (badges); `text` still drives filters and CSV. */
    node?: ReactNode;
    /** Makes the text a link. */
    href?: string;
};

export type QueueRow = {
    id: string;
    cells: Record<string, QueueCell>;
    /** A per-row control in a trailing column (the eligibility decision box). Never exported. */
    action?: ReactNode;
};

type Props = {
    columns: QueueColumn[];
    rows: QueueRow[];
    /** Base name of the downloaded file; the date is appended. */
    csvName: string;
    emptyText: string;
    searchPlaceholder?: string;
};

/** ISO instant or plain date → the calendar day in IST as YYYY-MM-DD ("" when unparseable). */
export function istDay(v: string | null | undefined): string {
    if (!v) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function csvCell(v: string): string {
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function EcofyQueueGrid({ columns, rows, csvName, emptyText, searchPlaceholder }: Props) {
    const [search, setSearch] = useState("");
    const [open, setOpen] = useState(false);
    const [colFilters, setColFilters] = useState<Record<string, string>>({});
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");

    const dateCol = columns.find((c) => c.date);
    const filterable = columns.filter((c) => c.filter);

    // Distinct values per "select" column, from the FULL list, so a choice never
    // disappears because another filter hid its rows.
    const options = useMemo(() => {
        const out: Record<string, string[]> = {};
        for (const c of filterable) {
            if (c.filter !== "select") continue;
            const seen = new Set<string>();
            for (const r of rows) {
                const t = r.cells[c.key]?.text?.trim();
                if (t) seen.add(t);
            }
            out[c.key] = [...seen].sort((a, b) => a.localeCompare(b));
        }
        return out;
    }, [rows, filterable]);

    const activeCount = Object.values(colFilters).filter(Boolean).length + (from ? 1 : 0) + (to ? 1 : 0);

    const visible = useMemo(() => {
        const needle = search.trim().toLowerCase();
        return rows.filter((r) => {
            if (needle) {
                const hay = columns
                    .map((c) => `${r.cells[c.key]?.text ?? ""} ${r.cells[c.key]?.sub ?? ""}`)
                    .join(" ")
                    .toLowerCase();
                if (!hay.includes(needle)) return false;
            }
            for (const c of filterable) {
                const want = colFilters[c.key];
                if (!want) continue;
                const have = r.cells[c.key]?.text ?? "";
                if (c.filter === "select" ? have.trim() !== want : !have.toLowerCase().includes(want.toLowerCase())) return false;
            }
            if (dateCol && (from || to)) {
                const day = istDay(r.cells[dateCol.key]?.text);
                if (!day) return false;
                if (from && day < from) return false;
                if (to && day > to) return false;
            }
            return true;
        });
    }, [rows, columns, filterable, colFilters, from, to, search, dateCol]);

    function reset() {
        setColFilters({});
        setFrom("");
        setTo("");
    }

    function downloadCsv() {
        const header = columns.flatMap((c) => (rows.some((r) => r.cells[c.key]?.sub) ? [c.label, `${c.label} (detail)`] : [c.label]));
        const lines = visible.map((r) =>
            columns
                .flatMap((c) => {
                    const cell = r.cells[c.key];
                    const withSub = rows.some((x) => x.cells[c.key]?.sub);
                    return withSub ? [cell?.text ?? "", cell?.sub ?? ""] : [cell?.text ?? ""];
                })
                .map(csvCell)
                .join(","),
        );
        const csv = "﻿" + [header.map(csvCell).join(","), ...lines].join("\r\n");
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        try {
            const a = document.createElement("a");
            a.href = url;
            a.download = `${csvName}-${new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    const hasAction = rows.some((r) => r.action);

    return (
        <div className="rounded-xl border border-gray-100 bg-white shadow-sm">
            <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-4 py-3">
                <div className="relative min-w-[220px] flex-1 md:max-w-md">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={searchPlaceholder ?? "Search…"} className="pl-9" />
                </div>
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    aria-expanded={open}
                    className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                        activeCount > 0 ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                    }`}
                >
                    <SlidersHorizontal className="h-4 w-4" />
                    Filters
                    {activeCount > 0 && <span className="rounded-full bg-blue-600 px-1.5 text-[11px] font-semibold text-white">{activeCount}</span>}
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
                </button>
                <div className="ml-auto flex items-center gap-2">
                    <button
                        type="button"
                        onClick={downloadCsv}
                        disabled={visible.length === 0}
                        title="Download the rows currently shown, with the search and filters applied"
                        className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <Download className="h-4 w-4" />
                        Download CSV
                    </button>
                </div>

                {open && (
                    <div className="order-last w-full border-t border-gray-100 pt-3">
                        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
                            {filterable.map((c) => (
                                <QueueFilterField key={c.key} label={c.label}>
                                    {c.filter === "select" ? (
                                        <select
                                            value={colFilters[c.key] ?? ""}
                                            onChange={(e) => setColFilters((f) => ({ ...f, [c.key]: e.target.value }))}
                                            className={QUEUE_SELECT_CLASS}
                                        >
                                            <option value="">Any</option>
                                            {(options[c.key] ?? []).map((v) => (
                                                <option key={v} value={v}>
                                                    {v}
                                                </option>
                                            ))}
                                        </select>
                                    ) : (
                                        <input
                                            value={colFilters[c.key] ?? ""}
                                            onChange={(e) => setColFilters((f) => ({ ...f, [c.key]: e.target.value }))}
                                            placeholder={`Contains…`}
                                            className={QUEUE_SELECT_CLASS}
                                        />
                                    )}
                                </QueueFilterField>
                            ))}
                            {dateCol && (
                                <>
                                    <QueueFilterField label={`${dateCol.label} from`}>
                                        <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={QUEUE_SELECT_CLASS} />
                                    </QueueFilterField>
                                    <QueueFilterField label={`${dateCol.label} to`}>
                                        <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={QUEUE_SELECT_CLASS} />
                                    </QueueFilterField>
                                </>
                            )}
                        </div>
                        <div className="mt-3 flex justify-end">
                            <button
                                type="button"
                                onClick={reset}
                                disabled={activeCount === 0}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                <RotateCcw className="h-3.5 w-3.5" />
                                Clear filters
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                        <tr>
                            {columns.map((c) => (
                                <th key={c.key} className="px-4 py-3">
                                    {c.label}
                                </th>
                            ))}
                            {hasAction && <th className="px-4 py-3" />}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {visible.map((r) => (
                            <tr key={r.id} className="align-top">
                                {columns.map((c) => {
                                    const cell = r.cells[c.key];
                                    return (
                                        <td key={c.key} className={`px-4 py-3 ${c.mono ? "font-mono text-xs" : ""}`}>
                                            {cell?.node ?? (
                                                cell?.href ? (
                                                    <Link href={cell.href} className="font-medium text-blue-700 hover:underline">
                                                        {cell.text || "—"}
                                                    </Link>
                                                ) : (
                                                    cell?.text || "—"
                                                )
                                            )}
                                            {cell?.sub ? <div className="font-sans text-xs text-gray-500">{cell.sub}</div> : null}
                                        </td>
                                    );
                                })}
                                {hasAction && <td className="px-4 py-3 text-right">{r.action}</td>}
                            </tr>
                        ))}
                    </tbody>
                </table>
                {visible.length === 0 && (
                    <p className="p-10 text-center text-sm text-gray-500">{rows.length === 0 ? emptyText : "No rows match the search and filters."}</p>
                )}
            </div>
            <div className="border-t border-gray-100 px-4 py-2 text-xs text-gray-500">
                {visible.length === rows.length ? `${rows.length} result${rows.length === 1 ? "" : "s"}` : `${visible.length} of ${rows.length} results`}
            </div>
        </div>
    );
}
