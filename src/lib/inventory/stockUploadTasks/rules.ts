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

import { classifyHsn, normalizeHsn } from "@/lib/sales/invoiceLines";

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
    /**
     * The line's class when the source already decided it (a Vyapar line
     * mapped in Invoice Ledger › Item mapping). Absent = classify by HSN.
     */
    product_class?: string | null;
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
        .filter((l) => (l.product_class ? l.product_class === "battery" : classifyHsn(l.hsn_code) === "battery"))
        .map((l) => {
            const read = cleanSerials(l.serials ?? []);
            const serials = read.length ? read : serialsFromDescription(l.description);
            const quantity = Math.max(0, Math.round(l.quantity));
            return { line_no: l.line_no, quantity, serials, countMatches: serials.length === quantity };
        });
}

/**
 * Zoho invoice detail lines as batterySerialLines() takes them. Zoho has no
 * serial field: serials, when printed, sit in the name or description
 * ("Serial No: …"), so both go into the description.
 */
export function zohoLinesForSerials(
    lines: ReadonlyArray<{ name?: string | null; description?: string | null; quantity?: number | null; hsn_or_sac?: string | null }>,
): LineForSerials[] {
    return lines.map((l, i) => ({
        line_no: i + 1,
        hsn_code: normalizeHsn(l.hsn_or_sac),
        quantity: Number(l.quantity ?? 0) || 0,
        description: [l.name, l.description].filter((s): s is string => !!s && !!s.trim()).join("\n"),
    }));
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
    const parts =
        t.expected > 0
            ? [`${t.inStock} of ${t.expected} serial${t.expected === 1 ? "" : "s"} in the dealer's stock`]
            : // Battery count not read (no quantity on the line): it cannot close by itself.
              [`serials not read, battery count unknown · ${t.inStock} in the dealer's stock · close by hand once the stock is in`];
    if (t.otherDealer > 0) parts.push(`${t.otherDealer} under another dealer`);
    if (t.read < t.expected) parts.push(`${t.expected - t.read} serial${t.expected - t.read === 1 ? "" : "s"} not read from the invoice`);
    if (!t.buyerKnown) parts.push(BUYER_NOT_LINKED);
    return parts.join(" · ");
}

/** Shown on a task whose invoice is not linked to any dealer account yet. */
export const BUYER_NOT_LINKED = "buyer not linked to a dealer account (link the invoice in Invoice Ledger)";

/**
 * Invoices brought in by an import — the Vyapar sales register, the Zoho sync
 * or backfill — open a task only from the day tasks went live (E-348 applied
 * on both databases, 16 Oct 2026). A register or backfill covering earlier
 * months would otherwise open (and two days later escalate) one task per old
 * invoice whose stock was settled long ago. The Drive scan reads new files
 * only and is not gated. ISO date string.
 */
export const STOCK_TASKS_LIVE_FROM = "2026-10-16";

/** Does an imported invoice dated `invoiceDate` (YYYY-MM-DD, or null) open a task? */
export function importedInvoiceOpensTask(invoiceDate: string | null | undefined, liveFrom = STOCK_TASKS_LIVE_FROM): boolean {
    const d = String(invoiceDate ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true; // undated: cannot tell it is old
    return d >= liveFrom;
}

/**
 * Is the invoice gone — voided (invoice_voids, which a Vyapar cancellation
 * also writes, or Zoho status 'void') or fully reversed by credit notes raised
 * against it? Returns the close note, or null. `credited` is the sum of the
 * not-voided credit notes against this invoice number; ₹1 absorbs rounding.
 */
export function invoiceReversal(input: {
    voided: boolean;
    invoiceTotal: number | null;
    credited: number;
    creditNotes?: readonly string[];
}): string | null {
    if (input.voided) return "Invoice voided";
    const total = Number(input.invoiceTotal ?? 0);
    if (total > 0 && input.credited >= total - 1) {
        const list = (input.creditNotes ?? []).filter(Boolean);
        return `Invoice fully reversed by credit note${list.length > 1 ? "s" : ""}${list.length ? ` ${list.join(", ")}` : ""}`;
    }
    return null;
}

/**
 * How a task was closed (stock_upload_tasks.closed_how, varchar(10)):
 *   auto       every serial is in the buyer's stock
 *   by_hand    closed by a person on the Stock to upload page
 *   voided     the invoice was voided or fully credit-noted
 *   not_dealer the invoice was marked "not a dealer sale" in Invoice Ledger
 *              (no dealer will ever stock it; ID 174 item 2)
 */
export type StockTaskClosedHow = "auto" | "by_hand" | "voided" | "not_dealer";

/** The words the task list shows for each closed_how. */
export function closedHowLabel(how: string | null | undefined): string {
    switch (how) {
        case "by_hand":
            return "by hand";
        case "voided":
            return "invoice voided / credit-noted";
        case "not_dealer":
            return "not a dealer sale";
        default:
            return "all serials in stock";
    }
}

/**
 * Which task table an Invoice Ledger decision points at. The ledger's
 * sources are 'zoho' | 'drive' | 'credit'; tasks exist only for 'drive'
 * (sales_invoices) and 'zoho' invoices — a credit note never has a task.
 */
export function taskSourceOfLedger(source: string | null | undefined): "drive" | "zoho" | null {
    return source === "drive" || source === "zoho" ? source : null;
}

/** The close note on a task closed because its invoice is not a dealer sale. */
export function notDealerSaleCloseNote(note: string | null | undefined): string {
    const n = String(note ?? "").trim();
    return `Marked not a dealer sale in Invoice Ledger${n ? `: ${n}` : ""}`;
}

/** The escalation bell's text for one overdue task. */
export function escalationMessage(t: {
    invoiceNumber: string | null;
    customerName: string | null;
    inStock: number;
    expected: number;
    buyerKnown: boolean;
}): string {
    const head = `Invoice ${t.invoiceNumber ?? "(no number)"} · ${t.customerName ?? "buyer unknown"}: `;
    if (!t.buyerKnown) {
        return head + `still open after ${STOCK_TASK_WORKING_DAYS} working days: ${BUYER_NOT_LINKED}.`;
    }
    if (t.expected <= 0) {
        return head + `serials not read from the invoice, still open after ${STOCK_TASK_WORKING_DAYS} working days. Close it by hand once the stock is in.`;
    }
    return head + `${t.inStock} of ${t.expected} batteries in the dealer's stock after ${STOCK_TASK_WORKING_DAYS} working days.`;
}
