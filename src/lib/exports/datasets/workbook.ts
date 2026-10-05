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
}

/** A date-only string → a Date at UTC midnight, which Excel shows as that calendar day. */
function excelDate(v: unknown): Date | null {
    if (!v) return null;
    const s = String(v);
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** A timestamp → the same instant shifted so Excel displays IST wall-clock. */
function excelDateTimeIst(v: unknown): Date | null {
    if (!v) return null;
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
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
        ...sheets.map((s): [string, string] => [`Rows — ${s.name}`, s.rows.length.toLocaleString("en-IN")]),
        ["Rows included", ctx.ownOnly ? "Only the rows this person owns." : "Every row matching the filters."],
        ["Phone numbers", ctx.fullPhone ? "Full numbers (a reason was recorded)." : "Masked (98xxxxx343)."],
        ...Object.entries(ctx.filters).map(([k, v]): [string, string] => [`Filter — ${k}`, v]),
    ];
    if (Object.keys(ctx.filters).length === 0) facts.push(["Filters", "None — the default range."]);
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

/** CSV carries one table, so it is the dataset's first sheet. Dates stay as stored. */
export function buildCsv(sheet: DatasetSheet, ctx: FileContext): string {
    const lines = [sheet.columns.map((c) => csvCell(c.header)).join(",")];
    for (const r of sheet.rows) {
        lines.push(
            sheet.columns
                .map((c) => {
                    const v = r[c.key];
                    if (c.kind === "phone") return csvCell(ctx.fullPhone ? v : maskPhone(v == null ? null : String(v)));
                    return csvCell(typeof v === "boolean" ? (v ? "Yes" : "No") : v);
                })
                .join(","),
        );
    }
    // BOM so Excel opens ₹ and Hindi names correctly.
    return `﻿${lines.join("\r\n")}\r\n`;
}
