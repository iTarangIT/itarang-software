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
 *
 * ID 200 (28 Oct, from Finance's sample): Vyapar's "Sale Report" export has
 * two sheets — "Sale Report" (one row per invoice / credit note: GSTIN,
 * Total Amount, Received/Paid Amount, Balance Due, Due Date, Status Paid /
 * Unpaid / Overdue N Days / Cancelled) and "Item Details" (the lines). When
 * both are there they are read together, joined on the invoice number, so
 * the register carries each invoice's payments as well as its lines.
 */
import * as XLSX from "xlsx";
import { classifyHsn, normalizeHsn, parseAmount, type ProductClass } from "./invoiceLines";
import { screenCustomerGstin } from "@/lib/leads/gstin";
import { cleanSerials, serialsFromDescription, serialsFromList } from "@/lib/inventory/stockUploadTasks/rules";

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
    | "doc_type"
    | "serial"
    | "description"
    // ID 200 — payments, per invoice (the Sale Report sheet).
    | "received"
    | "balance"
    | "due_date";

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
    // ID 174: battery serials — Vyapar's serial / IMEI tracking column, and the
    // line description where serials are typed as "Serial No: …".
    serial: ["serialno", "serialnumber", "serialnos", "serialnumbers", "serials", "serialnoimei", "imeino", "imeinumber", "imei"],
    description: ["description", "itemdescription", "itemdetails", "desc"],
    received: ["receivedpaidamount", "receivedamount", "paidamount", "amountreceived", "received"],
    balance: ["balancedue", "balanceamount", "amountdue", "balance"],
    due_date: ["duedate", "paymentduedate"],
};

/** Headers that a GSTR-1 rate split carries and we deliberately ignore. */
const IGNORED = ["placeofsupply", "cess", "cessamount", "rate", "reversecharge", "applicable", "ecommerce", "unit", "discount", "sno", "srno", "paymenttype", "partyphone", "phoneno", "salesmanager"];

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

// Order matters: specific fields claim their column before generic ones
// ("Item Serial No" goes to serial before item's substring match sees it; an
// only "Item Description" column goes to item before description).
// ID 200: "Due Date" before date, "Received/Paid Amount" and "Balance Due"
// before the amount / total fields whose substring match would take them.
const FIELD_ORDER: Field[] = ["gstin", "number", "due_date", "date", "party", "hsn", "serial", "item", "description", "qty", "received", "balance", "taxable", "tax", "total", "rate", "amount", "status", "doc_type"];

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
    /** The line's description column, when the export has one. */
    description: string | null;
    /** ID 174 — battery serials read for this line (serial column, else "Serial No: …" in the description or name). */
    serials: string[];
}

export interface ParsedDocument {
    number: string;
    date: string | null;
    party: string | null;
    gstin: string | null;
    /** ID 62 — why the party GSTIN was dropped (fails the check, or is ours); null when fine. */
    gstin_attention: string | null;
    cancelled: boolean;
    doc_type: "invoice" | "credit_note";
    taxable: number | null;
    tax: number | null;
    total: number | null;
    lines: ParsedLine[];
    /** ID 200 — "Received/Paid Amount" (or total less "Balance Due"); absent when the file has no payments. */
    amount_paid?: number | null;
    /** ID 200 — "Balance Due" as Vyapar shows it. */
    balance_due?: number | null;
    /** ID 200 — "Due Date"; null when blank (the CRM's own due date is kept). */
    due_date?: string | null;
    /** ID 200 — the status text as exported ("Paid", "Unpaid", "Overdue 28 Days"). */
    status_text?: string | null;
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

type SheetPick = { sheet: string; row: number; cols: Partial<Record<Field, number>>; headers: string[]; rows: unknown[][] };

/** The header row (within the first 20) that names the most known columns, +10 when `required` are all found. */
function bestHeader(name: string, rows: unknown[][], required: Field[]): { pick: SheetPick; score: number } | null {
    let best: { pick: SheetPick; score: number } | null = null;
    for (let r = 0; r < Math.min(rows.length, 20); r++) {
        const headers = (rows[r] ?? []).map((h) => String(h ?? "").trim());
        const cols = mapColumns(headers);
        const score = Object.keys(cols).length + (required.every((f) => cols[f] != null) ? 10 : 0);
        if (!best || score > best.score) best = { pick: { sheet: name, row: r, cols, headers, rows }, score };
    }
    return best;
}

function columnsOf(p: SheetPick): Partial<Record<Field, string>> {
    return Object.fromEntries(Object.entries(p.cols).map(([f, i]) => [f, p.headers[i as number]])) as Partial<Record<Field, string>>;
}

function unknownColumnsOf(p: SheetPick): string[] {
    const used = new Set(Object.values(p.cols));
    return p.headers.filter((h, i) => h && !used.has(i) && !IGNORED.some((g) => norm(h).includes(g)));
}

/** Every document on one sheet, in row order. Totals are finished by finishDocuments. */
function readDocuments(p: SheetPick, kind: ImportKind): { docs: Map<string, ParsedDocument>; skipped: number } {
    const c = p.cols;
    const cell = (row: unknown[], f: Field) => (c[f] != null ? row[c[f] as number] : undefined);
    const docs = new Map<string, ParsedDocument>();
    let last: ParsedDocument | null = null;
    let skipped = 0;

    for (let r = p.row + 1; r < p.rows.length; r++) {
        const row = p.rows[r] ?? [];
        if (row.every((v) => v === "" || v == null)) continue;
        const rawNumber = String(cell(row, "number") ?? "").trim();
        // Footer rows ("Total", "Grand Total") carry amounts but no document.
        if (/^(grand\s*)?total/i.test(rawNumber) || /^(grand\s*)?total/i.test(String(row[0] ?? ""))) continue;

        let doc: ParsedDocument | null;
        if (rawNumber) {
            doc = docs.get(rawNumber) ?? null;
            if (!doc) {
                const gst = screenCustomerGstin(String(cell(row, "gstin") ?? ""));
                doc = {
                    number: rawNumber,
                    date: parseDateCell(cell(row, "date")),
                    party: String(cell(row, "party") ?? "").trim() || null,
                    gstin: gst.gstin,
                    gstin_attention: gst.attention,
                    cancelled: false,
                    doc_type: isCreditNote(p.sheet, cell(row, "doc_type")) ? "credit_note" : "invoice",
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

        // ID 200 — payments, when the sheet has them (one row per invoice).
        if (c.received != null || c.balance != null) {
            const received = parseAmount(cell(row, "received"));
            const balance = parseAmount(cell(row, "balance"));
            if (received != null) doc.amount_paid = received;
            if (balance != null) doc.balance_due = balance;
        }
        if (c.due_date != null) {
            const due = parseDateCell(cell(row, "due_date"));
            if (due) doc.due_date = due;
            else if (doc.due_date === undefined) doc.due_date = null;
        }
        const statusText = String(cell(row, "status") ?? "").trim();
        if (statusText) doc.status_text = statusText;

        if (kind === "gstr1") {
            // GSTR-1 splits one invoice into a row per tax rate: taxable values
            // add up, the invoice value repeats.
            if (taxable != null) doc.taxable = (doc.taxable ?? 0) + taxable;
            if (total != null) doc.total = Math.max(doc.total ?? 0, total);
            continue;
        }

        const item = String(cell(row, "item") ?? "").trim();
        const description = String(cell(row, "description") ?? "").trim();
        const serials = cleanSerials([
            ...serialsFromList(cell(row, "serial")),
            ...serialsFromDescription(description),
            ...serialsFromDescription(item),
        ]);
        if (!item) {
            // A row carrying only serials (one serial per row under its item):
            // they belong to the line above.
            const prev = doc.lines[doc.lines.length - 1];
            if (prev && serials.length) {
                prev.serials = cleanSerials([...prev.serials, ...serials]);
                continue;
            }
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
            description: description || null,
            serials,
        });
        if (tax != null) doc.tax = (doc.tax ?? 0) + tax;
        if (total != null && c.item != null && c.total != null) doc.total = (doc.total ?? 0) + total;
    }
    return { docs, skipped };
}

/** Taxable from the lines, total from taxable + tax, paid from total less balance; date warnings. */
function finishDocuments(docs: Iterable<ParsedDocument>, kind: ImportKind, warnings: string[]): void {
    for (const d of docs) {
        if (kind === "gstr1") {
            if (d.taxable != null && d.total != null) d.tax = Math.round((d.total - d.taxable) * 100) / 100;
            continue;
        }
        const sum = d.lines.reduce((s, l) => s + (l.amount_excl_gst ?? 0), 0);
        d.taxable = d.lines.length ? Math.round(sum * 100) / 100 : d.taxable;
        if (d.total == null && d.taxable != null && d.tax != null) d.total = Math.round((d.taxable + d.tax) * 100) / 100;
        // ID 200: only a balance given — what was received is the rest.
        if (d.amount_paid == null && d.balance_due != null && d.total != null) {
            d.amount_paid = Math.round(Math.max(0, d.total - d.balance_due) * 100) / 100;
        }
        if (!d.date) warnings.push(`${d.number}: no readable date.`);
    }
}

const numberKey = (n: string) => n.toUpperCase().replace(/\s+/g, "");

/**
 * ID 200 — Vyapar's two-sheet Sale Report: documents and payments from "Sale
 * Report", lines from "Item Details", joined on the invoice number. An
 * invoice on Item Details only is kept, with a warning.
 */
function parseSaleReportPair(wb: XLSX.WorkBook, saleName: string, itemsName: string): ParseResult {
    const kind: ImportKind = "vyapar_register";
    const rowsOfSheet = (n: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, raw: true, defval: "" });
    const sale = bestHeader(saleName, rowsOfSheet(saleName), ["number", "total"]);
    const items = bestHeader(itemsName, rowsOfSheet(itemsName), ["number", "item"]);
    const sheet = `${saleName} + ${itemsName}`;
    const empty: ParseResult = { kind, sheet, header_row: null, columns: {}, unknown_columns: [], documents: [], warnings: [] };
    if (!sale || !items) return { ...empty, warnings: ["The file has no readable sheet."] };
    const columns = { ...columnsOf(items.pick), ...columnsOf(sale.pick) };
    const unknown_columns = [
        ...unknownColumnsOf(sale.pick).map((h) => `${saleName}: ${h}`),
        ...unknownColumnsOf(items.pick).map((h) => `${itemsName}: ${h}`),
    ];
    const missing = [
        ...(["number", "total"] as Field[]).filter((f) => sale.pick.cols[f] == null).map((f) => `${f} (${saleName})`),
        ...(["number", "item"] as Field[]).filter((f) => items.pick.cols[f] == null).map((f) => `${f} (${itemsName})`),
    ];
    if (missing.length) {
        return {
            ...empty,
            header_row: sale.pick.row + 1,
            columns,
            unknown_columns,
            warnings: [`Could not find a column for: ${missing.join(", ")}.`],
        };
    }

    const warnings: string[] = [];
    const head = readDocuments(sale.pick, kind);
    const lines = readDocuments(items.pick, kind);
    const byKey = new Map([...lines.docs.values()].map((d) => [numberKey(d.number), d]));
    const out: ParsedDocument[] = [];
    for (const d of head.docs.values()) {
        const l = byKey.get(numberKey(d.number));
        if (l) {
            d.lines = l.lines;
            if (d.tax == null) d.tax = l.tax;
            if (!d.date) d.date = l.date;
            if (l.cancelled) d.cancelled = true;
            byKey.delete(numberKey(d.number));
        }
        out.push(d);
    }
    for (const l of byKey.values()) {
        warnings.push(`${l.number}: on ${itemsName} but not on ${saleName}; read without payments.`);
        out.push(l);
    }
    finishDocuments(out, kind, warnings);
    const skipped = head.skipped + lines.skipped;
    if (skipped) warnings.push(`${skipped} row(s) before the first invoice number were skipped.`);
    return { kind, sheet, header_row: sale.pick.row + 1, columns, unknown_columns, documents: out, warnings };
}

export function parseInvoiceWorkbook(buffer: ArrayBuffer | Buffer, kind: ImportKind): ParseResult {
    const wb = XLSX.read(buffer, { cellDates: true });
    if (kind === "vyapar_register") {
        const saleName = wb.SheetNames.find((n) => /sale\s*report/i.test(n));
        const itemsName = wb.SheetNames.find((n) => /item\s*details/i.test(n));
        if (saleName && itemsName) return parseSaleReportPair(wb, saleName, itemsName);
    }
    let best: SheetPick | null = null;
    let bestScore = -1;
    for (const name of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: "" });
        const b = bestHeader(name, rows, REQUIRED[kind]);
        if (b && b.score > bestScore) {
            bestScore = b.score;
            best = b.pick;
        }
    }

    const empty: ParseResult = { kind, sheet: null, header_row: null, columns: {}, unknown_columns: [], documents: [], warnings: [] };
    if (!best) return { ...empty, warnings: ["The file has no readable sheet."] };
    const missing = REQUIRED[kind].filter((f) => best!.cols[f] == null);
    const columns = columnsOf(best);
    const unknown_columns = unknownColumnsOf(best);
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

    const warnings: string[] = [];
    const { docs, skipped } = readDocuments(best, kind);
    finishDocuments(docs.values(), kind, warnings);
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
