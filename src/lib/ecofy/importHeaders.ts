// Header row of an uploaded lead file, for the import wizard's mapping step
// (BRD FR-03.3). Server-side so the browser never loads the xlsx parser.
//
// Template v0.3 keeps the data on a sheet named "Leads" (with "How to fill",
// "Example", "Field guide" and "Lists" alongside), so that sheet wins; any
// other workbook or a CSV uses its first sheet. Pure: bytes in, headers out.

import * as XLSX from "xlsx";

export function readImportHeaders(bytes: Buffer | Uint8Array): string[] {
    const wb = XLSX.read(bytes, { type: "buffer", sheetRows: 1 });
    const name = wb.SheetNames.find((n) => n.trim().toLowerCase() === "leads") ?? wb.SheetNames[0];
    if (!name) return [];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, blankrows: false, defval: "" });
    const first = rows[0] ?? [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const cell of first) {
        const h = String(cell ?? "").trim();
        if (h && !seen.has(h)) {
            seen.add(h);
            out.push(h);
        }
    }
    return out;
}
