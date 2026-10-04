/**
 * E-322 (tracker IDs 39, 71) — reading a Vyapar sales register or a GSTR-1
 * export. PURE (no database) so it is unit-tested; ./vyaparImport.ts applies
 * the result.
 *
 * No sample export was available when this was built, so columns are found by
 * NAME, tolerantly — headers are reduced to bare alphanumerics and matched
 * against candidate lists, exact match first, then substring (the same scheme
 * as the buyback bank-statement reader). The header row is whichever of the
 * first rows names the most known columns, and the sheet is whichever sheet
 * scores best. Every column that was not recognised is reported back to the
 * person importing, and the preview shows what was read before anything is
 * written — check it against a real export.
 */
import * as XLSX from "xlsx";
import { classifyHsn, normalizeHsn, parseAmount, type ProductClass } from "./invoiceLines";
import { normalizeGstin, isValidGstin } from "@/lib/leads/gstin";

export type ImportKind = "vyapar_register" | "gstr1";

const norm = (s: unknown) =>
    String(s ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

type Field =
    | "number"
    | "date"
    | "party"
    | "gstin"
    | "item"
    | "hsn"
    | "qty"
    | "rate"
    | "taxable"
    | "amount"
    | "tax"
    | "total"
    | "status"
    | "doc_type";

const CANDIDATES: Record<Field, string[]> = {
    number: ["invoiceno", "invoicenumber", "billno", "billnumber", "txnno", "transactionno", "refno", "voucherno", "notenumber", "notevoucherno", "documentnumber", "docno"],
    date: ["invoicedate", "date", "billdate", "txndate", "transactiondate", "notedate", "notevoucherdate", "documentdate"],
    party: ["partyname", "customername", "receivername", "nameofrecipient", "party", "customer", "buyer"],
    gstin: ["partygstin", "gstinuinofrecipient", "gstinuin", "gstin", "customergstin", "gstno", "gstnumber"],
    item: ["itemname", "productname", "item", "product", "itemdescription"],
    hsn: ["hsnsac", "hsnsaccode", "hsncode", "hsn"],
    qty: ["quantity", "qty"],
    rate: ["priceunit", "priceperunit", "unitprice", "rate", "price"],
    taxable: ["taxablevalue", "taxableamount", "amountbeforetax", "amountexcltax", "amountexclgst"],
    amount: ["amount", "itemamount", "lineamount"],
    tax: ["taxamount", "gstamount", "totaltax", "tax"],
    total: ["invoicevalue", "notevalue", "grandtotal", "totalamount", "invoiceamount", "total"],
    status: ["status", "invoicestatus", "txnstatus"],
    doc_type: ["transactiontype", "txntype", "documenttype", "notetype", "type"],
};

/** Headers that a GSTR-1 rate split carries and we deliberately ignore. */
const IGNORED = ["placeofsupply", "cess", "cessamount", "rate", "reversecharge", "applicable", "ecommerce", "unit", "discount", "sno", "srno", "paymenttype", "received", "balance", "description"];

function pick(headers: string[], field: Field, taken: Set<number>): number {
    const cands = CANDIDATES[field];
    const normed = headers.map(norm);
    for (const c of cands) {
        const i = normed.findIndex((h, idx) => !taken.has(idx) && h === c);
        if (i >= 0) return i;
    }
    for (const c of cands) {
        if (c.length < 4) continue;
        const i = normed.findIndex((h, idx) => !taken.has(idx) && h.includes(c));
        if (i >= 0) return i;
    }
    return -1;
}

// Order matters: specific fields claim their column before generic ones.
const FIELD_ORDER: Field[] = ["gstin", "number", "date", "party", "hsn", "item", "qty", "taxable", "tax", "total", "rate", "amount", "status", "doc_type"];

function mapColumns(headers: string[]): Partial<Record<Field, number>> {
    const taken = new Set<number>();
    const out: Partial<Record<Field, number>> = {};
    for (const f of FIELD_ORDER) {
        const i = pick(headers, f, taken);
        if (i >= 0) {
            out[f] = i;
            taken.add(i);
        }
    }
    return out;
}

/** YYYY-MM-DD from a Date, an Excel serial, dd/mm/yyyy, dd-mm-yyyy, dd-Mon-yyyy or ISO. */
export function parseDateCell(v: unknown): string | null {
    if (v == null || v === "") return null;
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
        // SheetJS gives local-midnight Dates; read the calendar fields.
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, "0");
        const d = String(v.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }
    if (typeof v === "number" && v > 20000 && v < 80000) {
        const ms = Math.round((v - 25569) * 86400_000);
        return new Date(ms).toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (m) {
        const y = m[3].length === 2 ? `20${m[3]}` : m[3];
        return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    }
    const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    m = s.match(/^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{2,4})$/);
    if (m) {
        const mi = MON.indexOf(m[2].toLowerCase());
        if (mi >= 0) {
            const y = m[3].length === 2 ? `20${m[3]}` : m[3];
            return `${y}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
        }
    }
    return null;
}

export interface ParsedLine {
    item_name: string | null;
    hsn: string | null;
    product_class: ProductClass;
    quantity: number | null;
    rate: number | null;
    amount_excl_gst: number | null;
}

export interface ParsedDocument {
    number: string;
    date: string | null;
    party: string | null;
    gstin: string | null;
    cancelled: boolean;
    doc_type: "invoice" | "credit_note";
    taxable: number | null;
    tax: number | null;
    total: number | null;
    lines: ParsedLine[];
}

export interface ParseResult {
    kind: ImportKind;
    sheet: string | null;
    header_row: number | null;
    /** field → the header it was read from. */
    columns: Partial<Record<Field, string>>;
    /** Headers not recognised (and not deliberately ignored). */
    unknown_columns: string[];
    documents: ParsedDocument[];
    warnings: string[];
}

const REQUIRED: Record<ImportKind, Field[]> = {
    vyapar_register: ["number", "item"],
    gstr1: ["number", "total"],
};

function isCancelled(...cells: unknown[]): boolean {
    return cells.some((c) => /cancel/i.test(String(c ?? "")));
}

function isCreditNote(sheetName: string, ...cells: unknown[]): boolean {
    return /cdn|credit/i.test(sheetName) || cells.some((c) => /credit\s*note|^c$|^cn$/i.test(String(c ?? "").trim()));
}

export function parseInvoiceWorkbook(buffer: ArrayBuffer | Buffer, kind: ImportKind): ParseResult {
    const wb = XLSX.read(buffer, { cellDates: true });
    let best: { sheet: string; row: number; cols: Partial<Record<Field, number>>; headers: string[]; rows: unknown[][] } | null = null;
    let bestScore = -1;
    for (const name of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: "" });
        for (let r = 0; r < Math.min(rows.length, 20); r++) {
            const headers = (rows[r] ?? []).map((h) => String(h ?? "").trim());
            const cols = mapColumns(headers);
            const score = Object.keys(cols).length + (REQUIRED[kind].every((f) => cols[f] != null) ? 10 : 0);
            if (score > bestScore) {
                bestScore = score;
                best = { sheet: name, row: r, cols, headers, rows };
            }
        }
    }

    const empty: ParseResult = { kind, sheet: null, header_row: null, columns: {}, unknown_columns: [], documents: [], warnings: [] };
    if (!best) return { ...empty, warnings: ["The file has no readable sheet."] };
    const missing = REQUIRED[kind].filter((f) => best!.cols[f] == null);
    const columns = Object.fromEntries(
        Object.entries(best.cols).map(([f, i]) => [f, best!.headers[i as number]]),
    ) as Partial<Record<Field, string>>;
    const used = new Set(Object.values(best.cols));
    const unknown_columns = best.headers.filter(
        (h, i) => h && !used.has(i) && !IGNORED.some((g) => norm(h).includes(g)),
    );
    if (missing.length) {
        return {
            ...empty,
            sheet: best.sheet,
            header_row: best.row + 1,
            columns,
            unknown_columns,
            warnings: [`Could not find a column for: ${missing.join(", ")}. Headers seen: ${best.headers.filter(Boolean).join(" | ")}`],
        };
    }

    const c = best.cols;
    const cell = (row: unknown[], f: Field) => (c[f] != null ? row[c[f] as number] : undefined);
    const docs = new Map<string, ParsedDocument>();
    const warnings: string[] = [];
    let last: ParsedDocument | null = null;
    let skipped = 0;

    for (let r = best.row + 1; r < best.rows.length; r++) {
        const row = best.rows[r] ?? [];
        if (row.every((v) => v === "" || v == null)) continue;
        const rawNumber = String(cell(row, "number") ?? "").trim();
        // Footer rows ("Total", "Grand Total") carry amounts but no document.
        if (/^(grand\s*)?total/i.test(rawNumber) || /^(grand\s*)?total/i.test(String(row[0] ?? ""))) continue;

        let doc: ParsedDocument | null;
        if (rawNumber) {
            doc = docs.get(rawNumber) ?? null;
            if (!doc) {
                const gst = normalizeGstin(String(cell(row, "gstin") ?? ""));
                doc = {
                    number: rawNumber,
                    date: parseDateCell(cell(row, "date")),
                    party: String(cell(row, "party") ?? "").trim() || null,
                    gstin: isValidGstin(gst) ? gst : null,
                    cancelled: false,
                    doc_type: isCreditNote(best.sheet, cell(row, "doc_type")) ? "credit_note" : "invoice",
                    taxable: null,
                    tax: null,
                    total: null,
                    lines: [],
                };
                docs.set(rawNumber, doc);
            }
            last = doc;
        } else {
            // A continuation row (another item on the invoice above).
            doc = last;
        }
        if (!doc) {
            skipped++;
            continue;
        }
        if (isCancelled(cell(row, "status"), cell(row, "doc_type"))) doc.cancelled = true;

        const taxable = parseAmount(cell(row, "taxable"));
        const amount = parseAmount(cell(row, "amount"));
        const tax = parseAmount(cell(row, "tax"));
        const total = parseAmount(cell(row, "total"));
        const qty = parseAmount(cell(row, "qty"));
        const rate = parseAmount(cell(row, "rate"));

        if (kind === "gstr1") {
            // GSTR-1 splits one invoice into a row per tax rate: taxable values
            // add up, the invoice value repeats.
            if (taxable != null) doc.taxable = (doc.taxable ?? 0) + taxable;
            if (total != null) doc.total = Math.max(doc.total ?? 0, total);
            continue;
        }

        const item = String(cell(row, "item") ?? "").trim();
        if (!item) {
            // An invoice-level row with totals only.
            if (total != null) doc.total = total;
            continue;
        }
        const hsn = normalizeHsn(cell(row, "hsn"));
        // Before GST: the taxable value when the export has it, else the
        // amount less its tax, else quantity × rate, else the amount as given.
        const excl =
            taxable ??
            (amount != null && tax != null ? amount - tax : null) ??
            (qty != null && rate != null ? qty * rate : null) ??
            amount;
        doc.lines.push({
            item_name: item,
            hsn,
            product_class: classifyHsn(hsn),
            quantity: qty,
            rate,
            amount_excl_gst: excl == null ? null : Math.round(excl * 100) / 100,
        });
        if (tax != null) doc.tax = (doc.tax ?? 0) + tax;
        if (total != null && c.item != null && c.total != null) doc.total = (doc.total ?? 0) + total;
    }

    for (const d of docs.values()) {
        if (kind === "gstr1") {
            if (d.taxable != null && d.total != null) d.tax = Math.round((d.total - d.taxable) * 100) / 100;
            continue;
        }
        const sum = d.lines.reduce((s, l) => s + (l.amount_excl_gst ?? 0), 0);
        d.taxable = d.lines.length ? Math.round(sum * 100) / 100 : d.taxable;
        if (d.total == null && d.taxable != null && d.tax != null) d.total = Math.round((d.taxable + d.tax) * 100) / 100;
        if (!d.date) warnings.push(`${d.number}: no readable date.`);
    }
    if (skipped) warnings.push(`${skipped} row(s) before the first invoice number were skipped.`);

    return {
        kind,
        sheet: best.sheet,
        header_row: best.row + 1,
        columns,
        unknown_columns,
        documents: [...docs.values()],
        warnings,
    };
}
