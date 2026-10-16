/**
 * Tracker ID 174 — "Stock to upload" tasks: the pure rules.
 *
 * Decision (Kartik, 10 Oct):
 *   - each new battery invoice read creates a task for the Inventory Manager,
 *     Admin and partner (Chirag);
 *   - the check is by SERIAL and BUYER only — every battery serial printed on
 *     the invoice must be in the stock of the dealer on the invoice (Bill To
 *     GSTIN); no model matching (nothing in the CRM holds the OEM code);
 *   - each serial shows as in stock, missing, or in stock under another dealer;
 *   - the task closes by itself when every serial is in that dealer's stock;
 *     a partial upload stays open;
 *   - still open after 2 working days (office calendar): escalated, bell to
 *     Admin and a line in the daily email.
 *
 * CLIENT-SAFE and pure (no I/O); unit-tested in __tests__/rules.test.ts.
 */

import { classifyHsn } from "@/lib/sales/invoiceLines";

/** Working days a task may stay open before it escalates. */
export const STOCK_TASK_WORKING_DAYS = 2;

export type SerialStatus = "in_stock" | "missing" | "other_dealer";
export type StockTaskStatus = "open" | "escalated" | "closed";

/** One serial as compared: upper-case, no spaces or stray punctuation at the ends. */
export function normalizeSerial(raw: unknown): string | null {
    const s = String(raw ?? "")
        .toUpperCase()
        .replace(/\s+/g, "")
        .replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, "");
    // A serial carries a digit and is at least 4 characters; "NO", "SR" and
    // stray words from the description are not serials.
    return s.length >= 4 && s.length <= 100 && /\d/.test(s) ? s : null;
}

/** Distinct normalized serials, in the order first seen. */
export function cleanSerials(list: readonly unknown[] | null | undefined): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of list ?? []) {
        const s = normalizeSerial(v);
        if (s && !seen.has(s)) {
            seen.add(s);
            out.push(s);
        }
    }
    return out;
}

/**
 * Serials printed inside an item description, e.g.
 * "LiFePO4 51.2V 105Ah (FG3WMFG00320)\nSerial No: ITB2501, ITB2502".
 * Fallback for when the reader returns the serials only inside the name.
 */
export function serialsFromDescription(description: string | null | undefined): string[] {
    const m = String(description ?? "").match(/serial\s*(?:no|nos|number|numbers)?\.?\s*[:\-]\s*([\s\S]+)$/i);
    if (!m) return [];
    return cleanSerials(m[1].split(/[,;/|\n\r\t ]+/));
}

export type LineForSerials = {
    line_no: number;
    hsn_code: string | null;
    quantity: number;
    description: string;
    serials?: readonly string[] | null;
};

export type BatterySerialLine = {
    line_no: number;
    quantity: number;
    serials: string[];
    /** The count of serials read equals the line's quantity (the reader's check). */
    countMatches: boolean;
};

/**
 * The battery lines of an invoice with their serials: the serials the reader
 * returned, else the ones printed in the description. Battery = HSN 8507…
 * except 850790… (parts), the same classification the battery counts use.
 */
export function batterySerialLines(lines: readonly LineForSerials[]): BatterySerialLine[] {
    return lines
        .filter((l) => classifyHsn(l.hsn_code) === "battery")
        .map((l) => {
            const read = cleanSerials(l.serials ?? []);
            const serials = read.length ? read : serialsFromDescription(l.description);
            const quantity = Math.max(0, Math.round(l.quantity));
            return { line_no: l.line_no, quantity, serials, countMatches: serials.length === quantity };
        });
}

/** Expected = battery quantity; read = distinct serials over all battery lines. */
export function invoiceSerialTotals(lines: readonly BatterySerialLine[]): { expected: number; serials: string[] } {
    const expected = lines.reduce((a, l) => a + l.quantity, 0);
    return { expected, serials: cleanSerials(lines.flatMap((l) => l.serials)) };
}

/**
 * Where each serial is: in the buyer's stock, in another dealer's stock, or
 * missing. `stockDealerBySerial` maps a normalized serial to the dealer
 * holding it (null dealer = in stock with no dealer = not the buyer's).
 */
export function classifySerials(
    serials: readonly string[],
    stockDealerBySerial: ReadonlyMap<string, string | null>,
    buyerAccountId: string | null,
): Array<{ serial: string; status: SerialStatus; dealerId: string | null }> {
    return serials.map((serial) => {
        if (!stockDealerBySerial.has(serial)) return { serial, status: "missing" as const, dealerId: null };
        const dealerId = stockDealerBySerial.get(serial) ?? null;
        const mine = !!buyerAccountId && dealerId === buyerAccountId;
        return { serial, status: mine ? ("in_stock" as const) : ("other_dealer" as const), dealerId };
    });
}

/**
 * Does the task close by itself? Only when the buyer is known, every expected
 * serial was read (a reader that missed some must not close the task early),
 * and every one of them is in the buyer's stock.
 */
export function taskComplete(input: {
    buyerAccountId: string | null;
    expected: number;
    statuses: ReadonlyArray<{ status: SerialStatus }>;
}): boolean {
    if (!input.buyerAccountId || input.expected <= 0) return false;
    if (input.statuses.length < input.expected) return false;
    return input.statuses.every((s) => s.status === "in_stock");
}

/** Should an open task escalate now? `now` is the database clock. */
export function shouldEscalate(status: StockTaskStatus, dueAt: Date | null, now: Date): boolean {
    return status === "open" && !!dueAt && now.getTime() > dueAt.getTime();
}

/** The daily email line: "3 open, 1 overdue". */
export function stockTaskLine(open: number, overdue: number): string {
    return `${open} open, ${overdue} overdue`;
}

/** One line on a task's progress, for the Needs-action list and the bell. */
export function stockTaskProgress(t: {
    expected: number;
    read: number;
    inStock: number;
    otherDealer: number;
    buyerKnown: boolean;
}): string {
    const parts = [`${t.inStock} of ${t.expected} serial${t.expected === 1 ? "" : "s"} in the dealer's stock`];
    if (t.otherDealer > 0) parts.push(`${t.otherDealer} under another dealer`);
    if (t.read < t.expected) parts.push(`${t.expected - t.read} serial${t.expected - t.read === 1 ? "" : "s"} not read from the invoice`);
    if (!t.buyerKnown) parts.push("buyer not matched to a dealer account");
    return parts.join(" · ");
}
