// Turns a dataset's sheets into the file (tracker ID 13): Excel with a last
// sheet "About this file" — filters used, who, when, row count and a one-line
// meaning for every column — or CSV of the first sheet. Phone columns are
// masked here, in one place, unless the caller was cleared for full numbers.

import ExcelJS from "exceljs";

import { styleHeader, zebra } from "@/lib/excel/sheetStyle";
import { maskPhone, type DatasetColumn, type DatasetSheet } from "./types";

export interface FileContext {
    datasetLabel: string;
    downloadedBy: string;
    filters: Record<string, string>;
    fullPhone: boolean;
    ownOnly: boolean;
    /** ID 224: the dates the file really covers, in words (range.ts effectiveRange). */
    rangeText?: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const IST_MS = 5.5 * 60 * 60 * 1000;

/**
 * ID 224 — one reading of every timestamp the datasets hand over. A Date is an
 * instant; a string with Z or an offset is an instant; a naive
 * "YYYY-MM-DD HH:MM[:SS]" (Postgres `timestamp` columns and to_jsonb text) is
 * stored as UTC, so it is read as UTC — never in the server's own zone.
 */
export function parseInstant(v: unknown): Date | null {
    if (v == null || v === "") return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
    const s = String(v).trim();
    const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
    const d = new Date(naive ? `${s.replace(" ", "T")}Z` : DATE_ONLY.test(s) ? `${s}T00:00:00Z` : s);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** A date-only string → a Date at UTC midnight, which Excel shows as that calendar day. */
function excelDate(v: unknown): Date | null {
    if (!v) return null;
    if (typeof v === "string" && DATE_ONLY.test(v.slice(0, 10)) && v.length <= 10) return parseInstant(v);
    // A timestamp in a date column: its IST calendar day.
    const d = parseInstant(v);
    if (!d) return null;
    return new Date(`${new Date(d.getTime() + IST_MS).toISOString().slice(0, 10)}T00:00:00Z`);
}

/** A timestamp → the same instant shifted so Excel displays IST wall-clock. */
function excelDateTimeIst(v: unknown): Date | null {
    const d = parseInstant(v);
    return d ? new Date(d.getTime() + IST_MS) : null;
}

/** ID 224: a CSV date cell — the IST calendar day, YYYY-MM-DD. */
export function csvDateIst(v: unknown): string {
    if (v == null || v === "") return "";
    if (typeof v === "string" && DATE_ONLY.test(v)) return v;
    const d = parseInstant(v);
    return d ? new Date(d.getTime() + IST_MS).toISOString().slice(0, 10) : String(v);
}

/** ID 224: a CSV date-time cell — IST wall clock, YYYY-MM-DD HH:MM (a 4:15 pm call reads 16:15). */
export function csvDateTimeIst(v: unknown): string {
    if (v == null || v === "") return "";
    const d = parseInstant(v);
    if (!d) return String(v);
    return new Date(d.getTime() + IST_MS).toISOString().slice(0, 16).replace("T", " ");
}

function cell(col: DatasetColumn, v: unknown, fullPhone: boolean): ExcelJS.CellValue {
    if (v == null || v === "") return null;
    switch (col.kind) {
        case "phone":
            return fullPhone ? String(v) : maskPhone(String(v));
        case "date":
            return excelDate(v);
        case "datetime":
            return excelDateTimeIst(v);
        case "money":
        case "number": {
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        }
        default:
            return typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
    }
}

const NUM_FMT: Partial<Record<NonNullable<DatasetColumn["kind"]>, string>> = {
    date: "dd-mmm-yyyy",
    datetime: "dd-mmm-yyyy hh:mm",
    money: "#,##0.00",
};

const nowIst = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

export async function buildXlsx(sheets: DatasetSheet[], ctx: FileContext): Promise<ArrayBuffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = "iTarang CRM";
    wb.created = new Date();

    for (const sheet of sheets) {
        const ws = wb.addWorksheet(sheet.name, { views: [{ state: "frozen", ySplit: 1 }] });
        ws.columns = sheet.columns.map((c) => ({ header: c.header, width: c.width ?? 18 }));
        styleHeader(ws.getRow(1));
        sheet.columns.forEach((c, i) => {
            const fmt = c.kind ? NUM_FMT[c.kind] : undefined;
            if (fmt) ws.getColumn(i + 1).numFmt = fmt;
        });
        sheet.rows.forEach((r, i) => zebra(ws.addRow(sheet.columns.map((c) => cell(c, r[c.key], ctx.fullPhone))), i));
        if (sheet.rows.length > 0) {
            ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
        }
    }

    const about = wb.addWorksheet("About this file");
    about.columns = [{ header: "Item", width: 34 }, { header: "Detail", width: 110 }];
    styleHeader(about.getRow(1));
    const facts: [string, string][] = [
        ["Dataset", ctx.datasetLabel],
        ["Downloaded by", ctx.downloadedBy],
        ["Downloaded at (IST)", nowIst()],
        ["Dates covered", ctx.rangeText ?? "—"],
        ...sheets.map((s): [string, string] => [`Rows — ${s.name}`, s.rows.length.toLocaleString("en-IN")]),
        ["Rows included", ctx.ownOnly ? "Only the rows this person owns (a manager: also his team's, ID 155)." : "Every row matching the filters."],
        ["Phone numbers", ctx.fullPhone ? "Full numbers (a reason was recorded)." : "Masked (98xxxxx343)."],
        ...Object.entries(ctx.filters).map(([k, v]): [string, string] => [`Filter — ${k}`, v]),
    ];
    const otherFilters = Object.keys(ctx.filters).filter((k) => k !== "from" && k !== "to" && k !== "date_field");
    if (otherFilters.length === 0) facts.push(["Filters", "None besides the dates above."]);
    let n = 0;
    for (const f of facts) zebra(about.addRow(f), n++);
    for (const sheet of sheets) {
        about.addRow([]);
        const head = about.addRow([`Columns — ${sheet.name}`, "Meaning"]);
        head.font = { bold: true };
        for (const c of sheet.columns) zebra(about.addRow([c.header, c.meaning]), n++);
    }

    return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

const csvCell = (v: unknown): string => {
    if (v == null) return "";
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * CSV carries one table, so it is the dataset's first sheet. ID 224: dates in
 * IST and one format — YYYY-MM-DD for a date, YYYY-MM-DD HH:MM for a date-time
 * (they used to be UTC, in three shapes, so a 4:15 pm call read 10:45).
 */
export function buildCsv(sheet: DatasetSheet, ctx: FileContext): string {
    const lines = [sheet.columns.map((c) => csvCell(c.header)).join(",")];
    for (const r of sheet.rows) {
        lines.push(
            sheet.columns
                .map((c) => {
                    const v = r[c.key];
                    if (c.kind === "phone") return csvCell(ctx.fullPhone ? v : maskPhone(v == null ? null : String(v)));
                    if (c.kind === "datetime") return csvCell(csvDateTimeIst(v));
                    if (c.kind === "date") return csvCell(csvDateIst(v));
                    return csvCell(typeof v === "boolean" ? (v ? "Yes" : "No") : v);
                })
                .join(","),
        );
    }
    // BOM so Excel opens ₹ and Hindi names correctly.
    return `﻿${lines.join("\r\n")}\r\n`;
}
