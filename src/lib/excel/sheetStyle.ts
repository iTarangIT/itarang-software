/**
 * Shared ExcelJS sheet styling.
 *
 * These three helpers were copy-pasted across four export routes. Lifted here
 * verbatim from the single-lead history export so a new multi-lead export does
 * not become a fifth copy. The other three duplicates (scraper run, AI-dialer
 * campaign, scraper batch template) are deliberately left alone — they work,
 * and rewriting them is not this change's job.
 */

import type ExcelJS from "exceljs";

/** Dark header band: white bold text on FF1A1A1A, centred, 28px tall. */
export function styleHeader(row: ExcelJS.Row) {
    row.eachCell((cell) => {
        cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF1A1A1A" },
        };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
        cell.alignment = { vertical: "middle", horizontal: "center" };
    });
    row.height = 28;
}

/** Alternating row fill + wrapped text + hairline rule under every row. */
export function zebra(row: ExcelJS.Row, i: number) {
    if (i % 2 === 0) {
        row.eachCell((cell) => {
            cell.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FFF9FAFB" },
            };
        });
    }
    row.eachCell((cell) => {
        cell.alignment = { vertical: "middle", wrapText: true };
        cell.border = { bottom: { style: "hair", color: { argb: "FFE5E7EB" } } };
    });
}

/**
 * Timestamps are rendered in IST, not the server's timezone — the people
 * reading these files are in India and a UTC column silently reads as "the
 * call happened 5.5 hours earlier than it did".
 */
export function fmtIst(d: Date | string | null | undefined): string {
    return d
        ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
        : "—";
}
