/**
 * A33 — bulk upload of Hot / Warm / Cold. Pure parsing: the route resolves
 * each row to a lead and applies it through setInterestLevel (audited, like a
 * manual change). Client-safe.
 *
 * A CSV with a header row. One lead per row, found by lead_id, else by phone
 * (last 10 digits). The level column is interest / interest_level / level /
 * temperature, with hot / warm / cold (or H / W / C), any case.
 */

export type InterestLevelValue = "hot" | "warm" | "cold";

export type InterestUploadRow = {
    /** 1-based line in the file (the header is line 1). */
    line: number;
    leadId: string | null;
    /** Last 10 digits. */
    phone: string | null;
    level: InterestLevelValue | null;
    error: string | null;
};

export const INTEREST_UPLOAD_MAX_ROWS = 5000;

const LEVELS: Record<string, InterestLevelValue> = { hot: "hot", h: "hot", warm: "warm", w: "warm", cold: "cold", c: "cold" };

/** One CSV line into cells: commas, double quotes, "" for a quote inside quotes. */
export function csvCells(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"' && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else if (ch === '"') quoted = false;
            else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ",") {
            out.push(cur);
            cur = "";
        } else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export function parseInterestCsv(text: string): { rows: InterestUploadRow[]; error: string | null } {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/);
    const header = (lines[0] ?? "").trim();
    if (!header) return { rows: [], error: "The file is empty." };
    const cols = csvCells(header).map(norm);
    const idCol = cols.findIndex((c) => c === "lead_id" || c === "id" || c === "leadid");
    const phoneCol = cols.findIndex((c) => ["phone", "mobile", "phone_number", "mobile_number", "contact_number"].includes(c));
    const levelCol = cols.findIndex((c) => ["interest", "interest_level", "level", "temperature", "hot_warm_cold"].includes(c));
    if (levelCol === -1) return { rows: [], error: "No interest column — name it interest (values hot, warm or cold)." };
    if (idCol === -1 && phoneCol === -1) return { rows: [], error: "No lead_id or phone column to find the lead by." };

    const rows: InterestUploadRow[] = [];
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        if (rows.length >= INTEREST_UPLOAD_MAX_ROWS) return { rows, error: `More than ${INTEREST_UPLOAD_MAX_ROWS} rows — split the file.` };
        const cells = csvCells(lines[i]);
        const leadId = idCol >= 0 ? cells[idCol] || null : null;
        const digits = phoneCol >= 0 ? (cells[phoneCol] ?? "").replace(/\D/g, "") : "";
        const phone = digits.length >= 10 ? digits.slice(-10) : null;
        const raw = (cells[levelCol] ?? "").trim().toLowerCase();
        const level = LEVELS[raw] ?? null;
        let error: string | null = null;
        if (!leadId && !phone) error = digits ? "Phone has fewer than 10 digits" : "No lead id or phone";
        else if (!level) error = raw ? `"${cells[levelCol]}" is not hot, warm or cold` : "No interest level";
        rows.push({ line: i + 1, leadId, phone, level, error });
    }
    return { rows, error: rows.length ? null : "No data rows under the header." };
}
