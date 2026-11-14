// AI Analyst — taking an answer's table out (251 item 20): Copy table, Download (Excel) and
// links from a lead or dealer id to its page. Client-safe and pure.
//
// The table is what the analyst's read-only login (analyst_ro) could read: phones, PAN and
// documents are already withheld there, so nothing is masked here again. The download is
// logged like every other data download (ID 13) through POST /api/analyst/downloads.

import { renderCell } from "./cells";
import type { Cell } from "./run-types";

/** A cell as plain text: what the screen prints (null as empty). */
export function cellText(value: Cell): string {
    const r = renderCell(value);
    return r.kind === "null" ? "" : r.text;
}

/** Tab-separated, one row per line: pastes into Excel or Sheets as a grid. */
export function tableToTsv(columns: string[], rows: Cell[][]): string {
    const clean = (s: string) => s.replace(/[\t\r\n]+/g, " ");
    return [columns.map(clean).join("\t"), ...rows.map((row) => row.map((v) => clean(cellText(v))).join("\t"))].join("\n");
}

const LEAD_ID_COLUMN = /^(dealer_)?lead_id$|^lead$/i;
const ACCOUNT_ID_COLUMN = /^(account_id|dealer_account_id)$/i;
/** Lead ids look like "DL-…" or "L-…"; dealer accounts like "ACC-…". */
const LEAD_ID = /^(DL|L)-[\w-]{4,}$/;
const ACCOUNT_ID = /^ACC-[\w-]{3,}$/;

/**
 * Where a cell should link, or null. Only id columns that look like CRM ids link, and a name
 * column links when its row also carries a lead / account id (the CEO reads names, not ids).
 */
export function cellLink(columns: string[], row: Cell[], index: number): string | null {
    const column = columns[index] ?? "";
    const text = cellText(row[index] ?? null);
    if (LEAD_ID_COLUMN.test(column) && LEAD_ID.test(text)) return `/inside-sales/lead/${encodeURIComponent(text)}`;
    if (ACCOUNT_ID_COLUMN.test(column) && ACCOUNT_ID.test(text)) return `/my-dealers/${encodeURIComponent(text)}`;
    if (/(^|_)(dealer_name|shop_name|business_name|name)$/i.test(column) && text) {
        const leadAt = columns.findIndex((c) => LEAD_ID_COLUMN.test(c));
        const leadId = leadAt >= 0 ? cellText(row[leadAt] ?? null) : "";
        if (LEAD_ID.test(leadId)) return `/inside-sales/lead/${encodeURIComponent(leadId)}`;
        const accAt = columns.findIndex((c) => ACCOUNT_ID_COLUMN.test(c));
        const accId = accAt >= 0 ? cellText(row[accAt] ?? null) : "";
        if (ACCOUNT_ID.test(accId)) return `/my-dealers/${encodeURIComponent(accId)}`;
    }
    return null;
}

/** "visits-by-salesperson-2026-11-14.xlsx" from the question and today's IST date. */
export function downloadName(question: string, now: Date = new Date()): string {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
    const slug = question
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50)
        .replace(/-+$/g, "");
    return `${slug || "analyst-answer"}-${day}.xlsx`;
}

/** 251 item 21: a question long enough to fold to three lines (more than 3 lines, or about 4 lines of text). */
export function isLongQuestion(text: string): boolean {
    return text.split(/\r?\n/).length > 3 || text.length > 280;
}
