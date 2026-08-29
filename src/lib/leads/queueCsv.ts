/**
 * Turning queue rows into the CSV a sales manager opens in Excel.
 *
 * SERVER-SIDE, and deliberately not the browser-side Blob that
 * components/buyback/ui/ExportCsvButton builds: a queue page holds 25 rows and
 * the question a download answers is "give me everything matching what I am
 * looking at", which is a few thousand. Exporting what happens to be on screen
 * would hand over page 1 of 40 with no hint that it had.
 *
 * The conventions here — BOM, CRLF, IST timestamps, the truncation headers — are
 * the ones /api/dealer-leads/export established, kept identical so the lead
 * exports all open the same way in the same spreadsheet.
 */

/** RFC-4180: quote only when the value needs it, doubling any quote inside. */
export function csvEscape(v: unknown): string {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * `YYYY-MM-DD HH:mm` in IST.
 *
 * Not an ISO string with a Z: Excel and Sheets both parse this shape as a real
 * datetime, while ISO-8601 lands as text and cannot be sorted — the first thing
 * anyone does to a follow-up sheet. IST because every user of this CRM is in one
 * timezone and a UTC "last touched" reads five and a half hours early.
 */
export function csvDateTime(v: unknown): string {
    if (!v) return "";
    const d = new Date(v as string);
    if (Number.isNaN(d.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/**
 * A bare YYYY-MM-DD cell.
 *
 * `scheduled_date` and `actual_visit_date` are DATE columns already selected as
 * text, and running them through csvDateTime would parse them as UTC midnight
 * and print the previous day in IST — a visit scheduled for the 7th appearing as
 * the 6th on the sheet.
 */
export function csvDate(v: unknown): string {
    if (!v) return "";
    const s = String(v);
    return s.length >= 10 ? s.slice(0, 10) : s;
}

/** `Transferred_to_ASM` → `Transferred To ASM`, for a sheet a human reads. */
export function csvPretty(v: unknown): string {
    if (v == null || v === "") return "";
    return String(v)
        .replaceAll("_", " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

export type CsvColumn<R> = { header: string; value: (row: R) => string };

/**
 * Rows, not bytes. Large enough that no realistic queue filter is silently
 * truncated, small enough that nobody can ask for the whole lead table by
 * accident. When it bites it is REPORTED (X-Export-Truncated) rather than
 * quietly short-changing the sheet, which is what makes an export untrustworthy.
 */
export const QUEUE_EXPORT_ROW_CAP = 5_000;

export function csvResponse<R>({
    rows,
    columns,
    filename,
    total,
}: {
    rows: R[];
    columns: CsvColumn<R>[];
    /** Without the extension or the timestamp — both are added here. */
    filename: string;
    /** How many rows MATCHED, which may exceed how many were exported. */
    total: number;
}): Response {
    const lines = [
        columns.map((c) => csvEscape(c.header)).join(","),
        ...rows.map((r) => columns.map((c) => csvEscape(c.value(r))).join(",")),
    ];
    const stamp = csvDateTime(new Date()).replace(/[: ]/g, "-");

    return new Response(
        // Leading BOM so Excel reads it as UTF-8. Without it a dealer name with
        // any non-ASCII character renders as mojibake on a default Windows
        // install, which is where these sheets are actually opened.
        "﻿" + lines.join("\r\n"),
        {
            headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="${filename}-${stamp}.csv"`,
                // Read by the download button so a truncated export announces
                // itself instead of looking like the filter matched fewer.
                "X-Export-Rows": String(rows.length),
                "X-Export-Total": String(total),
                "X-Export-Truncated": total > rows.length ? "1" : "0",
            },
        },
    );
}
