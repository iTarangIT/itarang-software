/**
 * E-322 (tracker IDs 39, 71 / handover P1-8, P1-9) — applying a parsed Vyapar
 * sales register or GSTR-1 file. Parsing is ./vyaparParse.ts (pure).
 *
 * Sales register (weekly; Kartik, 26 Sep: batteries sold come from invoices
 * only). For each invoice in the file:
 *   * matched to sales_invoices by the normalised invoice number (the same
 *     dedupe key the Drive scan uses); an invoice the PDFs never produced is
 *     created with source 'vyapar';
 *   * the register OVERRIDES the PDF reading where it is better: the party
 *     GSTIN (so the invoice matches a dealer account) and the line items —
 *     replaced as a set in invoice_line_items (source 'vyapar');
 *   * an invoice the register lists as cancelled is voided (invoice_voids,
 *     origin 'vyapar'), which takes it out of revenue;
 *   * ID 200 (Vyapar's two-sheet Sale Report): each invoice's amount paid is
 *     set from its "Received/Paid Amount" — re-uploads update it — so a paid
 *     invoice drops out of Accounts Receivable; a blank Due Date keeps the
 *     CRM's own. A credit note on the register is added to credit_notes (it
 *     reduces what the customer owes), once per note number.
 *   * Payment sync (rules in ./registerPaymentRules.ts): the preview shows each
 *     invoice's amount paid before → after, the invoices whose payments go
 *     DOWN, CRM / Vyapar totals that disagree, the open CRM invoices of the
 *     same series and dates that the file does not list, and the open ones
 *     dated before the file starts (the export must reach back to them).
 *     An export older than the last one imported is refused unless the
 *     importer confirms (OlderExportError); imports run one at a time (an
 *     advisory lock); a rise in amount paid is dated to the export's
 *     "Generated on". E-368: a register credit note's used part (total less
 *     Balance Due) goes to credit_note_applications, so a note Vyapar has
 *     already adjusted against an invoice is not netted a second time.
 * Lines are mapped to CRM products through vyapar_item_map; unmapped item
 * names are listed for someone to map (mapping back-fills earlier lines).
 *
 * GSTR-1: the filed rows go to gstr1_entries for the monthly reconciliation.
 * A re-import of the same month replaces that month's rows.
 *
 * Each import is recorded in invoice_imports with its summary.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { normalizeInvoiceNumber } from "@/lib/sales/normalizeInvoiceNumber";
import { resolveSalesOrg } from "@/lib/sales/resolveSalesOrg";
import { itemFamilyKey, itemKey } from "@/lib/sales/invoiceLines";
import { classFor, isMapped, mappedClassSql, mappedItems, productFor, type ItemProduct } from "@/lib/sales/itemMap";
import { voidInvoice } from "@/lib/sales/invoiceVoids";
import { recheckStockTasks, recordInvoiceSerials } from "@/lib/inventory/stockUploadTasks/service";
import type { LineForSerials } from "@/lib/inventory/stockUploadTasks/rules";
import type { ImportKind, ParseResult, ParsedDocument } from "@/lib/sales/vyaparParse";
import { importActionFor, type ImportAction } from "@/lib/sales/importAction";
import { paymentStatusFor } from "@/lib/sales/paymentStatus";
import { hasCreditNoteApplications, hasInvoiceLedgerTables } from "@/lib/sales/ledgerTables";
import {
    creditNoteAppliedFor,
    invoiceSeries,
    isOlderExport,
    lastPaymentDateFor,
    paymentChangeFor,
    registerPaidFor,
    totalsDisagree,
    type PaymentChange,
} from "@/lib/sales/registerPaymentRules";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Runner = typeof db | Tx;

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

export interface ImportPlanRow {
    number: string;
    date: string | null;
    party: string | null;
    gstin: string | null;
    /** ID 62: the GSTIN printed for this party failed the check — why (null = fine). */
    gstin_attention: string | null;
    doc_type: "invoice" | "credit_note";
    cancelled: boolean;
    lines: number;
    batteries: number;
    /** ID 174: battery serials read on this invoice (a "Stock to upload" task closes by itself only when serials are read). */
    serials: number;
    taxable: number | null;
    /**
     * invoice_imports apply outcome: 'update' an existing invoice, or 'create';
     * 'in_zoho' (ID 200) — the number is an old Zoho invoice, already counted
     * from zoho_invoices, so it is skipped rather than counted twice.
     */
    action: ImportAction;
    existing_id: string | null;
    /** Payment sync — the invoice total the CRM holds (the register's for a new invoice). */
    crm_total?: number | null;
    /** Vyapar's Total Amount for this document. */
    register_total?: number | null;
    paid_before?: number | null;
    /** What this upload sets (capped at the CRM total); null when the file has no payment for it. */
    paid_after?: number | null;
    /** crm_total − paid_after: what the customer still owes on this invoice after the upload. */
    balance_after?: number | null;
    payment_change?: PaymentChange;
    /** The CRM and Vyapar totals differ by more than ₹1. */
    total_mismatch?: boolean;
    /** The amount paid was entered by hand (Payment button) and this upload lowers it. */
    overrides_manual?: boolean;
    /** The CRM invoice is already void — a "cancelled" row changes nothing. */
    already_void?: boolean;
}

/** Payment sync — what the upload does to amounts paid, and what it cannot see. */
export interface PaymentSyncPreview {
    /** This export's "Generated on" (ISO, IST); null when the file has no stamp. */
    generated_at: string | null;
    /** The newest register already imported. */
    last_generated_at: string | null;
    /** This export is older than the last one imported: importing it would roll payments back. */
    older_than_last: boolean;
    /** Invoices whose amount paid goes up / down. */
    increases: number;
    decreases: number;
    /** ₹ newly recorded as collected by this upload (sum of the rises). */
    collected: number;
    /** ₹ still owed on the invoices in the file after the upload (CRM totals). */
    open_balance: number;
    total_mismatches: number;
    /**
     * Open CRM invoices of the same series, dated inside the file's period,
     * that the file does not list — deleted or renumbered in Vyapar, or a
     * filtered export. Left untouched.
     */
    not_in_file: Array<{ number: string; party: string | null; date: string | null; balance: number }>;
    not_in_file_balance: number;
    /** Open CRM invoices of the same series dated BEFORE the file starts — this export cannot update them. */
    before_period: { count: number; balance: number; oldest: string | null };
}

export interface ImportPreview {
    kind: ImportKind;
    sheet: string | null;
    columns: ParseResult["columns"];
    unknown_columns: string[];
    warnings: string[];
    period: { from: string | null; to: string | null };
    totals: {
        documents: number;
        update: number;
        create: number;
        /** ID 200: register invoices already in Zoho, skipped (no double counting). */
        in_zoho: number;
        cancelled: number;
        lines: number;
        batteries: number;
        serials: number;
        unmapped_items: number;
        /** ID 62: documents whose GSTIN failed the check (kept off any dealer match). */
        gstin_refused: number;
    };
    unmapped_items: string[];
    rows: ImportPlanRow[];
    /** Present for a Vyapar register that carries payments (the Sale Report). */
    payments?: PaymentSyncPreview | null;
}

/** An export older than the last register imported — committing it would roll payments back. */
export class OlderExportError extends Error {
    constructor(
        readonly generatedAt: string,
        readonly lastGeneratedAt: string,
    ) {
        super(
            `This Vyapar export was generated ${generatedAt.slice(0, 16).replace("T", " ")}, before the last one imported ` +
                `(${lastGeneratedAt.slice(0, 16).replace("T", " ")}). Importing it would set payments back to older figures. ` +
                `Export the Sale Report again from Vyapar, or confirm the older file.`,
        );
        this.name = "OlderExportError";
    }
}

const IMPORT_LOCK = "invoice_imports:vyapar_register";

/** Today in India, YYYY-MM-DD. */
function istToday(): string {
    return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** The newest "Generated on" among committed register imports. */
async function lastRegisterGeneratedAt(runner: Runner): Promise<string | null> {
    const [row] = rowsOf<{ at: string | Date | null }>(
        await runner.execute(sql`
            SELECT MAX((summary->>'generated_at')::timestamptz) AS at
              FROM invoice_imports
             WHERE kind = 'vyapar_register'
               AND summary->>'generated_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'`),
    );
    return row?.at ? new Date(row.at).toISOString() : null;
}

type CrmInvoice = { id: string; total: number | null; amount_paid: number; voided: boolean; hand_marked: boolean };

async function crmInvoicesById(ids: string[]): Promise<Map<string, CrmInvoice>> {
    if (!ids.length) return new Map();
    const ledger = await hasInvoiceLedgerTables();
    const rows = rowsOf<{ id: string; total: string | null; amount_paid: string | null; status: string | null; voided: boolean; hand_marked: boolean }>(
        await db.execute(sql`
            SELECT si.id::text AS id, si.total::text AS total, si.amount_paid::text AS amount_paid, si.status,
                   ${ledger
                       ? sql`EXISTS (SELECT 1 FROM invoice_voids v WHERE v.source = 'drive' AND v.invoice_id = si.id::text)`
                       : sql`false`} AS voided,
                   (si.payment_marked_by IS NOT NULL AND COALESCE(si.payment_reference, '') <> 'Vyapar register') AS hand_marked
              FROM sales_invoices si
             WHERE si.id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`),
    );
    return new Map(
        rows.map((r) => [
            r.id,
            {
                id: r.id,
                total: r.total == null ? null : Number(r.total),
                amount_paid: Number(r.amount_paid ?? 0),
                voided: r.voided || r.status === "void",
                hand_marked: r.hand_marked,
            },
        ]),
    );
}

/**
 * Open CRM invoices of the file's series that the file cannot vouch for:
 * inside its period but not listed, and dated before it starts.
 */
async function coverageGaps(
    series: string[],
    keys: string[],
    period: { from: string | null; to: string | null },
): Promise<Pick<PaymentSyncPreview, "not_in_file" | "not_in_file_balance" | "before_period">> {
    const none = { not_in_file: [], not_in_file_balance: 0, before_period: { count: 0, balance: 0, oldest: null } };
    if (!series.length || !period.from || !period.to) return none;
    const ledger = await hasInvoiceLedgerTables();
    const open = sql`
        ${ledger ? sql`NOT EXISTS (SELECT 1 FROM invoice_voids v WHERE v.source = 'drive' AND v.invoice_id = si.id::text) AND` : sql``}
        COALESCE(si.status, '') NOT IN ('void', 'paid', 'draft')
        AND COALESCE(si.total, 0) - si.amount_paid > 0.5
        AND substring(upper(si.invoice_number) from '^([A-Z]{2,})[/-]') IN (${sql.join(series.map((s) => sql`${s}`), sql`, `)})`;
    const missing = rowsOf<{ number: string; party: string | null; date: string | null; balance: string }>(
        await db.execute(sql`
            SELECT si.invoice_number AS number, si.customer_name AS party, si.invoice_date::text AS date,
                   (COALESCE(si.total, 0) - si.amount_paid)::text AS balance
              FROM sales_invoices si
             WHERE ${open}
               AND si.invoice_date BETWEEN ${period.from}::date AND ${period.to}::date
               ${keys.length
                   ? sql`AND (si.invoice_number_key IS NULL OR si.invoice_number_key NOT IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)}))`
                   : sql``}
             ORDER BY COALESCE(si.total, 0) - si.amount_paid DESC
             LIMIT 200`),
    );
    const [before] = rowsOf<{ n: number; balance: string | null; oldest: string | null }>(
        await db.execute(sql`
            SELECT count(*)::int AS n, SUM(COALESCE(si.total, 0) - si.amount_paid)::text AS balance, MIN(si.invoice_date)::text AS oldest
              FROM sales_invoices si
             WHERE ${open}
               AND si.invoice_date < ${period.from}::date`),
    );
    const notInFile = missing.map((m) => ({ number: m.number, party: m.party, date: m.date, balance: Number(m.balance) }));
    return {
        not_in_file: notInFile,
        not_in_file_balance: Math.round(sum(notInFile.map((m) => m.balance)) * 100) / 100,
        before_period: {
            count: Number(before?.n ?? 0),
            balance: Math.round(Number(before?.balance ?? 0) * 100) / 100,
            oldest: before?.oldest ?? null,
        },
    };
}

async function existingByKey(runner: Runner, keys: string[]): Promise<Map<string, string>> {
    if (!keys.length) return new Map();
    const rows = rowsOf<{ k: string; id: string }>(
        await runner.execute(sql`
            SELECT invoice_number_key AS k, id::text AS id FROM sales_invoices
             WHERE invoice_number_key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`),
    );
    return new Map(rows.map((r) => [r.k, r.id]));
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * ID 200 — the key a register credit note is kept under. Vyapar numbers some
 * credit notes just "1", "2": those are keyed with their date so two years'
 * note 1 stay two notes.
 */
export function registerCreditNoteKey(number: string, date: string | null): string {
    const n = number.trim();
    if (/^\d+$/.test(n)) return `VYAPAR-CN-${n}-${date ?? "nodate"}`;
    return normalizeInvoiceNumber(n) ?? n.toUpperCase();
}

/**
 * ID 200 — set one invoice's amount paid from the register. Never above the
 * invoice total (an overpayment is a credit, not this invoice's balance); a
 * void invoice is left alone. The figure is absolute (Vyapar's total received
 * so far), so a re-upload changes nothing and a reversal comes back down. A
 * rise is dated to the export (`asOf`). Returns the change and the ₹ moved.
 */
async function applyRegisterPayment(
    runner: Runner,
    id: string,
    d: ParsedDocument,
    asOf: string | null,
    ledger: boolean,
): Promise<{ change: PaymentChange; delta: number }> {
    const nothing = { change: "none" as PaymentChange, delta: 0 };
    if (d.amount_paid == null && !d.due_date) return nothing;
    const [cur] = rowsOf<{ total: string | null; amount_paid: string | null; status: string | null; last_payment_date: string | null; voided: boolean }>(
        await runner.execute(sql`
            SELECT si.total::text AS total, si.amount_paid::text AS amount_paid, si.status, si.last_payment_date::text AS last_payment_date,
                   ${ledger
                       ? sql`EXISTS (SELECT 1 FROM invoice_voids v WHERE v.source = 'drive' AND v.invoice_id = si.id::text)`
                       : sql`false`} AS voided
              FROM sales_invoices si WHERE si.id = ${id}::uuid
               FOR UPDATE`),
    );
    if (!cur || cur.status === "void" || cur.voided) return nothing;
    const total = Number(cur.total ?? d.total ?? 0);
    const before = Number(cur.amount_paid ?? 0);
    const paid = registerPaidFor(d.amount_paid, total);
    const change = paymentChangeFor(before, paid);
    if (paid != null && (change === "increase" || change === "decrease")) {
        const lastPaid = lastPaymentDateFor(change, paid, asOf, cur.last_payment_date, istToday());
        await runner.execute(sql`
            UPDATE sales_invoices
               SET amount_paid = ${paid.toFixed(2)},
                   status = ${paymentStatusFor(paid, total)},
                   payment_reference = 'Vyapar register',
                   last_payment_date = ${lastPaid}::date,
                   due_date = COALESCE(${d.due_date ?? null}::date, due_date),
                   updated_at = now()
             WHERE id = ${id}::uuid`);
        return { change, delta: Math.round((paid - before) * 100) / 100 };
    }
    if (d.due_date) {
        await runner.execute(sql`
            UPDATE sales_invoices SET due_date = ${d.due_date}::date, updated_at = now()
             WHERE id = ${id}::uuid AND due_date IS DISTINCT FROM ${d.due_date}::date`);
    }
    return { change, delta: 0 };
}

/** E-368 — record how much of a register credit note Vyapar has already used. */
async function applyCreditNoteUse(
    runner: Runner,
    noteKey: string,
    d: ParsedDocument,
    asOf: string | null,
    importId: string,
): Promise<boolean> {
    const applied = creditNoteAppliedFor(d.total, d.balance_due);
    if (applied == null) return false;
    const [note] = rowsOf<{ id: string }>(
        await runner.execute(sql`SELECT id::text AS id FROM credit_notes WHERE note_number_key = ${noteKey} LIMIT 1`),
    );
    if (!note) return false;
    const res = rowsOf<{ id: string }>(
        await runner.execute(sql`
            INSERT INTO credit_note_applications (credit_note_id, amount_applied, source, as_of, import_id, updated_at)
            VALUES (${note.id}::uuid, ${applied.toFixed(2)}, 'vyapar', ${asOf}::timestamptz, ${importId}::uuid, now())
            ON CONFLICT (credit_note_id) DO UPDATE
               SET amount_applied = EXCLUDED.amount_applied, as_of = EXCLUDED.as_of,
                   import_id = EXCLUDED.import_id, updated_at = now()
             WHERE credit_note_applications.amount_applied IS DISTINCT FROM EXCLUDED.amount_applied
            RETURNING credit_note_id::text AS id`),
    );
    return res.length > 0;
}

function batteriesOf(d: ParsedDocument): number {
    return sum(d.lines.filter((l) => l.product_class === "battery").map((l) => l.quantity ?? 0));
}

function serialsOf(d: ParsedDocument): number {
    return sum(d.lines.filter((l) => l.product_class === "battery").map((l) => l.serials.length));
}

export async function previewImport(parsed: ParseResult): Promise<ImportPreview> {
    const docs = parsed.documents;
    const keyOf = (d: ParsedDocument) => normalizeInvoiceNumber(d.number);
    const existing =
        parsed.kind === "vyapar_register"
            ? await existingByKey(db, docs.map(keyOf).filter((k): k is string => !!k))
            : new Map<string, string>();
    // ID 200: an invoice number already in Zoho is the same sale; the register
    // must not add it a second time (the Drive scan has the same check).
    const zoho =
        parsed.kind === "vyapar_register" ? await (await import("@/lib/sales/driveSalesScan")).loadZohoNumberKeys() : new Set<string>();
    const mapped = await mappedItems(db);
    const unmapped = new Set<string>();
    // Payment sync: only a register that carries payments (Vyapar's Sale Report).
    const withPayments = parsed.kind === "vyapar_register" && docs.some((d) => d.amount_paid != null);
    const crm = withPayments ? await crmInvoicesById([...new Set(existing.values())]) : new Map<string, CrmInvoice>();
    const rows: ImportPlanRow[] = docs.map((d) => {
        for (const l of d.lines) if (l.item_name && !isMapped(mapped, l.item_name)) unmapped.add(l.item_name);
        const id = existing.get(keyOf(d) ?? "") ?? null;
        const action = importActionFor(parsed.kind, id, zoho.has(keyOf(d) ?? ""));
        const row: ImportPlanRow = {
            number: d.number,
            date: d.date,
            party: d.party,
            gstin: d.gstin,
            gstin_attention: d.gstin_attention,
            doc_type: d.doc_type,
            cancelled: d.cancelled,
            lines: d.lines.length,
            batteries: batteriesOf(d),
            serials: serialsOf(d),
            taxable: d.taxable,
            action,
            existing_id: id,
        };
        if (withPayments && id && crm.get(id)?.voided) row.already_void = true;
        if (withPayments && d.doc_type === "invoice" && !d.cancelled && (action === "update" || action === "create")) {
            const cur = id ? crm.get(id) : undefined;
            if (!(cur?.voided)) {
                const total = cur ? (cur.total ?? d.total ?? 0) : (d.total ?? 0);
                const before = cur?.amount_paid ?? 0;
                const after = registerPaidFor(d.amount_paid, total);
                const change = paymentChangeFor(before, after);
                Object.assign(row, {
                    crm_total: total,
                    register_total: d.total,
                    paid_before: before,
                    paid_after: after,
                    balance_after: Math.round((total - (after ?? before)) * 100) / 100,
                    payment_change: change,
                    total_mismatch: cur ? totalsDisagree(cur.total, d.total) : false,
                    overrides_manual: !!cur?.hand_marked && change === "decrease",
                });
            }
        }
        return row;
    });
    const dates = docs.map((d) => d.date).filter((d): d is string => !!d).sort();
    const period = { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };
    let payments: PaymentSyncPreview | null = null;
    if (withPayments) {
        const synced = rows.filter((r) => r.payment_change);
        const series = [...new Set(docs.filter((d) => d.doc_type === "invoice").map((d) => invoiceSeries(d.number)).filter((s): s is string => !!s))];
        const keys = docs.map(keyOf).filter((k): k is string => !!k);
        const last = await lastRegisterGeneratedAt(db);
        payments = {
            generated_at: parsed.generated_at ?? null,
            last_generated_at: last,
            older_than_last: isOlderExport(parsed.generated_at, last),
            increases: synced.filter((r) => r.payment_change === "increase").length,
            decreases: synced.filter((r) => r.payment_change === "decrease").length,
            collected: Math.round(
                sum(synced.filter((r) => r.payment_change === "increase").map((r) => (r.paid_after ?? 0) - (r.paid_before ?? 0))) * 100,
            ) / 100,
            open_balance: Math.round(sum(synced.map((r) => Math.max(r.balance_after ?? 0, 0))) * 100) / 100,
            total_mismatches: synced.filter((r) => r.total_mismatch).length,
            ...(await coverageGaps(series, keys, period)),
        };
    }
    return {
        kind: parsed.kind,
        sheet: parsed.sheet,
        columns: parsed.columns,
        unknown_columns: parsed.unknown_columns,
        warnings: parsed.warnings,
        period,
        totals: {
            documents: rows.length,
            update: rows.filter((r) => r.action === "update").length,
            create: rows.filter((r) => r.action === "create").length,
            in_zoho: rows.filter((r) => r.action === "in_zoho").length,
            cancelled: rows.filter((r) => r.cancelled).length,
            lines: sum(rows.map((r) => r.lines)),
            batteries: sum(rows.map((r) => r.batteries)),
            serials: sum(rows.map((r) => r.serials)),
            unmapped_items: unmapped.size,
            gstin_refused: rows.filter((r) => r.gstin_attention).length,
        },
        unmapped_items: [...unmapped].sort(),
        rows,
        payments,
    };
}

export type CommitSummary = ImportPreview["totals"] & {
    voided: number;
    created_ids: number;
    payments_set: number;
    /** Payment sync: invoices whose amount paid fell (a reversal in Vyapar). */
    payments_decreased: number;
    /** ₹ newly recorded as collected. */
    collected: number;
    credit_notes_added: number;
    /** E-368: credit notes whose used part changed. */
    credit_notes_applied: number;
    /** The export's "Generated on" (ISO, IST), when the file carries it. */
    generated_at: string | null;
};

export async function commitImport(
    parsed: ParseResult,
    meta: { fileName: string | null; actorId: string; allowOlder?: boolean },
): Promise<{ import_id: string; summary: CommitSummary }> {
    const preview = await previewImport(parsed);
    if (!parsed.documents.length) throw new Error("Nothing to import — no documents were read from the file.");
    const asOf = parsed.generated_at ?? null;
    const ledger = await hasInvoiceLedgerTables();
    const cnApplications = parsed.kind === "vyapar_register" && (await hasCreditNoteApplications());

    // ID 174: invoices whose lines this import wrote, for the "Stock to upload"
    // tasks opened after the transaction commits (they must read its rows).
    const stockTaskInputs: Array<{ id: string; lines: LineForSerials[] }> = [];
    let voidedAny = false;

    const result = await db.transaction(async (tx) => {
        let voided = 0;
        let created = 0;
        let paymentsSet = 0;
        let paymentsDown = 0;
        let collected = 0;
        let creditNotes = 0;
        let creditApplied = 0;
        const done = (importId: string) => ({
            import_id: importId,
            summary: {
                ...preview.totals,
                voided,
                created_ids: created,
                payments_set: paymentsSet,
                payments_decreased: paymentsDown,
                collected: Math.round(collected * 100) / 100,
                credit_notes_added: creditNotes,
                credit_notes_applied: creditApplied,
                generated_at: asOf,
            } satisfies CommitSummary,
        });

        if (parsed.kind === "vyapar_register") {
            // One register import at a time, and never an older export over a
            // newer one (checked again under the lock: a newer file may have
            // been committed since the preview).
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${IMPORT_LOCK}))`);
            const last = await lastRegisterGeneratedAt(tx);
            if (asOf && last && isOlderExport(asOf, last) && !meta.allowOlder) throw new OlderExportError(asOf, last);
        }

        const [imp] = rowsOf<{ id: string }>(
            await tx.execute(sql`
                INSERT INTO invoice_imports (kind, file_name, period_from, period_to, summary, imported_by)
                VALUES (${parsed.kind}, ${meta.fileName}, ${preview.period.from}::date, ${preview.period.to}::date,
                        ${JSON.stringify({ ...preview.totals, generated_at: asOf })}::jsonb, ${meta.actorId}::uuid)
                RETURNING id::text AS id`),
        );

        if (parsed.kind === "gstr1") {
            const months = [...new Set(parsed.documents.map((d) => (d.date ? d.date.slice(0, 7) + "-01" : null)).filter(Boolean))] as string[];
            if (months.length) {
                await tx.execute(sql`DELETE FROM gstr1_entries WHERE month IN (${sql.join(months.map((m) => sql`${m}::date`), sql`, `)})`);
            }
            for (const d of parsed.documents) {
                if (!d.date) continue;
                await tx.execute(sql`
                    INSERT INTO gstr1_entries (import_id, month, doc_type, doc_number, doc_number_key, doc_date, gstin, taxable_value, tax, total)
                    VALUES (${imp.id}::uuid, ${d.date.slice(0, 7) + "-01"}::date, ${d.doc_type}, ${d.number},
                            ${normalizeInvoiceNumber(d.number) ?? d.number.toUpperCase()}, ${d.date}::date, ${d.gstin},
                            ${d.taxable}, ${d.tax}, ${d.total})`);
            }
            return done(imp.id);
        }

        const mapped = await mappedItems(tx);
        for (const d of parsed.documents) {
            const plan = preview.rows.find((r) => r.number === d.number);
            if (d.doc_type === "credit_note") {
                // ID 200: a register credit note (Vyapar's Sale Report lists them
                // with the invoices) reduces what the customer owes. The Drive
                // credit-note folder adds the same note once; whichever comes
                // first keeps the number.
                if (d.cancelled || plan?.action === "in_zoho" || d.total == null) continue;
                const org = resolveSalesOrg({ invoiceNumber: d.number });
                const added = rowsOf<{ id: string }>(
                    await tx.execute(sql`
                        INSERT INTO credit_notes (note_number, note_number_key, issue_date, customer_name, customer_gstin,
                                                  organization_id, sub_total, tax_total, total, needs_attention, attention_reason)
                        VALUES (${d.number}, ${registerCreditNoteKey(d.number, d.date)}, ${d.date}::date, ${d.party}, ${d.gstin},
                                ${org.organizationId}, ${d.taxable}, ${d.tax}, ${d.total},
                                ${d.gstin_attention !== null}, ${d.gstin_attention})
                        ON CONFLICT DO NOTHING
                        RETURNING id::text AS id`),
                );
                if (added.length) creditNotes++;
                // E-368: the part Vyapar has already adjusted against an invoice
                // (that invoice's Received includes it) is not netted again.
                if (cnApplications && (await applyCreditNoteUse(tx, registerCreditNoteKey(d.number, d.date), d, asOf, imp.id))) {
                    creditApplied++;
                }
                continue;
            }
            const key = normalizeInvoiceNumber(d.number);
            if (!key) continue;
            if (plan?.action === "in_zoho") continue; // ID 200: counted from Zoho already
            let id = plan?.existing_id ?? null;
            if (!id) {
                const org = resolveSalesOrg({ invoiceNumber: d.number });
                const [row] = rowsOf<{ id: string }>(
                    await tx.execute(sql`
                        INSERT INTO sales_invoices (source, invoice_number, invoice_number_key, invoice_date, customer_name,
                                                    customer_gstin, organization_id, sub_total, tax_total, total, status,
                                                    needs_attention, attention_reason)
                        VALUES ('vyapar', ${d.number}, ${key}, ${d.date}::date, ${d.party}, ${d.gstin},
                                ${org.organizationId}, ${d.taxable}, ${d.tax}, ${d.total}, 'sent',
                                ${d.gstin_attention !== null}, ${d.gstin_attention})
                        ON CONFLICT DO NOTHING
                        RETURNING id::text AS id`),
                );
                if (!row) {
                    // Raced with a Drive scan that just created it.
                    id = (await existingByKey(tx, [key])).get(key) ?? null;
                } else {
                    id = row.id;
                    created++;
                }
                if (!id) continue;
            } else if (d.gstin) {
                // The register's party GSTIN overrides the PDF reading.
                await tx.execute(sql`
                    UPDATE sales_invoices SET customer_gstin = ${d.gstin}, updated_at = now()
                     WHERE id = ${id}::uuid AND customer_gstin IS DISTINCT FROM ${d.gstin}`);
            } else if (d.gstin_attention) {
                // ID 62 — the register's GSTIN was refused: say so on the
                // invoice (once) instead of dropping it silently.
                await tx.execute(sql`
                    UPDATE sales_invoices
                       SET needs_attention = true,
                           attention_reason = concat_ws(' ', NULLIF(attention_reason, ''), ${d.gstin_attention}::text),
                           updated_at = now()
                     WHERE id = ${id}::uuid
                       AND position(${d.gstin_attention}::text IN COALESCE(attention_reason, '')) = 0`);
            }

            if (d.lines.length) {
                await tx.execute(sql`DELETE FROM invoice_line_items WHERE invoice_id = ${id} AND source IN ('vyapar', 'drive')`);
                const taskLines: LineForSerials[] = [];
                if (!d.cancelled) stockTaskInputs.push({ id, lines: taskLines });
                let n = 0;
                for (const l of d.lines) {
                    n++;
                    const m = l.item_name ? productFor(mapped, l.item_name) : undefined;
                    const productClass = m ? classFor(m, l.product_class, l.hsn) : l.product_class;
                    // Serials as the parser read them (serial column, "Serial No: …"
                    // in the description or name); the name and description stay
                    // the rules' fallback.
                    taskLines.push({
                        line_no: n,
                        hsn_code: l.hsn,
                        quantity: l.quantity ?? 0,
                        description: [l.item_name, l.description].filter(Boolean).join("\n"),
                        serials: l.serials,
                        product_class: productClass,
                    });
                    await tx.execute(sql`
                        INSERT INTO invoice_line_items (source, invoice_id, line_no, item_name, hsn, product_class,
                                                        asset_type, product_id, quantity, rate, amount_excl_gst, import_id)
                        VALUES ('vyapar', ${id}, ${n}, ${l.item_name}, ${l.hsn}, ${productClass},
                                ${m?.asset_type ?? null}, ${m?.product_id ?? null}, ${l.quantity}, ${l.rate},
                                ${l.amount_excl_gst}, ${imp.id}::uuid)`);
                }
            }
            if (!d.cancelled) {
                const p = await applyRegisterPayment(tx, id, d, asOf, ledger);
                if (p.change === "increase" || p.change === "decrease") paymentsSet++;
                if (p.change === "decrease") paymentsDown++;
                if (p.delta > 0) collected += p.delta;
            }
            if (d.cancelled) {
                const r = await voidInvoice(
                    { source: "drive", invoiceId: id, reason: "Cancelled in Vyapar (sales register import)", origin: "vyapar", actorId: meta.actorId },
                    tx,
                );
                if (r.voided) voided++;
                voidedAny = true;
            }
        }
        // Remember every item name seen, mapped or not, so the mapping list is complete.
        for (const name of preview.unmapped_items) {
            await tx.execute(sql`
                INSERT INTO vyapar_item_map (item_key, item_name) VALUES (${itemKey(name)}, ${name})
                ON CONFLICT (item_key) DO NOTHING`);
        }
        return done(imp.id);
    });

    // ID 174 (E-348): a "Stock to upload" task per battery invoice — the same
    // sales_invoices row the Drive scan uses, so an invoice both read from
    // Drive and listed here keeps one task. Only invoices dated from the day
    // tasks went live (an old register must not open a task per past sale).
    // A cancelled invoice closes its task on the recheck. Never throws.
    for (const t of stockTaskInputs) {
        await recordInvoiceSerials(t.id, t.lines, { source: "drive", origin: "vyapar" });
    }
    if (voidedAny) await recheckStockTasks();
    return result;
}

/**
 * Map a Vyapar item name to a CRM product; back-fills lines already imported.
 *
 * The mapping is saved for the exact spelling AND its product family
 * (itemFamilyKey: product code, else cleaned name), and reaches every line of
 * that family — other spellings, and the same product billed with different
 * serial numbers. A sibling spelling someone mapped on its own keeps its own
 * mapping.
 */
export async function mapVyaparItem(input: {
    itemName: string;
    assetType: string | null;
    productId: string | null;
    actorId: string;
}): Promise<{ lines_updated: number; spellings: number }> {
    const key = itemKey(input.itemName);
    const family = itemFamilyKey(input.itemName);
    return db.transaction(async (tx) => {
        for (const k of family && family !== key ? [key, family] : [key]) {
            await tx.execute(sql`
                INSERT INTO vyapar_item_map (item_key, item_name, asset_type, product_id, mapped_by)
                VALUES (${k}, ${input.itemName}, ${input.assetType}, ${input.productId}, ${input.actorId}::uuid)
                ON CONFLICT (item_key) DO UPDATE SET asset_type = EXCLUDED.asset_type, product_id = EXCLUDED.product_id,
                                                     mapped_by = EXCLUDED.mapped_by, updated_at = now()`);
        }
        // Every spelling on a line that belongs to this family, minus siblings
        // with their own exact mapping (an explicit choice wins over the family).
        const seen = rowsOf<{ item_name: string }>(
            await tx.execute(sql`SELECT DISTINCT item_name FROM invoice_line_items WHERE item_name IS NOT NULL`),
        );
        const own = new Set(
            rowsOf<{ item_key: string }>(
                await tx.execute(sql`SELECT item_key FROM vyapar_item_map WHERE product_id IS NOT NULL AND item_key NOT LIKE 'code:%' AND item_key NOT LIKE 'name:%'`),
            ).map((r) => r.item_key),
        );
        const names = seen
            .map((r) => r.item_name)
            .filter((n) => itemKey(n) === key || (family != null && itemFamilyKey(n) === family && !own.has(itemKey(n))));
        if (names.length === 0) return { lines_updated: 0, spellings: 0 };
        const res = rowsOf<{ n: number }>(
            await tx.execute(sql`
                WITH u AS (
                    UPDATE invoice_line_items SET asset_type = ${input.assetType}, product_id = ${input.productId},
                           -- ID 172: an onboarding-fee line is revenue, never a battery.
                           -- A14: a line with no HSN takes its class from the mapping
                           -- (classFor in itemMap.ts — same rule on insert).
                           product_class = ${mappedClassSql(input.assetType)}
                     WHERE item_name IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
                    RETURNING 1)
                SELECT count(*)::int AS n FROM u`),
        );
        return { lines_updated: res[0]?.n ?? 0, spellings: new Set(names.map(itemKey)).size };
    });
}

export type FamilyBackfillReport = {
    /** Family keys written from a mapping saved for one spelling only (before 14 Oct). */
    families_written: Array<{ family_key: string; from_item: string; asset_type: string | null; product_id: string }>;
    /** Families whose spellings were mapped to different products — the latest mapping wins, as on Item mapping. */
    conflicts: Array<{ family_key: string; kept: string; also: string[] }>;
    /** Lines with no product that a saved mapping (exact, else family) now reaches. */
    lines_stamped: number;
    spellings_stamped: number;
    by_product: Array<{ asset_type: string | null; product_id: string; lines: number; spellings: number }>;
    applied: boolean;
};

/**
 * HANDOVER-A16 — one-off back-fill of product families onto invoice lines.
 *
 * Mappings saved before 14 Oct (when Item mapping started saving the family
 * key, mapVyaparItem) cover only their own spelling, so Item mapping shows the
 * family as mapped while its other spellings' lines stay "not linked" in gross
 * margin and By SKU. This runs every saved mapping through mapVyaparItem's
 * rules:
 *   1. for each exact mapping whose family has no row yet, write the family
 *      key (latest-saved spelling wins; a family row that exists — mapped or
 *      deliberately unmapped — is never touched);
 *   2. stamp asset_type / product_id / product_class (mappedClassSql — the
 *      classFor rule) on every line STILL WITHOUT a product whose item maps,
 *      exact spelling first, else its family (productFor). A line that already
 *      has a product is never changed.
 *
 * Dry run unless `apply`; idempotent — a second run finds nothing to do.
 */
export async function reapplyFamilyMappings(opts: { apply?: boolean; actorId?: string | null } = {}): Promise<FamilyBackfillReport> {
    const apply = opts.apply === true;
    type MapRow = { item_key: string; item_name: string; asset_type: string | null; product_id: string | null };
    const rows = rowsOf<MapRow>(
        await db.execute(sql`SELECT item_key, item_name, asset_type, product_id FROM vyapar_item_map ORDER BY updated_at DESC, item_key`),
    );
    const isFamilyKey = (k: string) => k.startsWith("code:") || k.startsWith("name:");
    const familyRows = new Set(rows.filter((r) => isFamilyKey(r.item_key)).map((r) => r.item_key));

    const written = new Map<string, FamilyBackfillReport["families_written"][number]>();
    const others = new Map<string, Set<string>>();
    for (const r of rows) {
        if (isFamilyKey(r.item_key) || !r.product_id) continue;
        const family = itemFamilyKey(r.item_name);
        if (!family || family === r.item_key || familyRows.has(family)) continue;
        const kept = written.get(family);
        if (!kept) {
            written.set(family, { family_key: family, from_item: r.item_name, asset_type: r.asset_type, product_id: r.product_id });
        } else if (kept.product_id !== r.product_id || kept.asset_type !== r.asset_type) {
            others.set(family, (others.get(family) ?? new Set()).add(r.item_name));
        }
    }

    // What productFor() reads once the family keys above exist (mappedItems() + them).
    const mapped = new Map<string, ItemProduct>(
        rows.filter((r) => r.product_id).map((r) => [r.item_key, { asset_type: r.asset_type, product_id: r.product_id }]),
    );
    for (const w of written.values()) mapped.set(w.family_key, { asset_type: w.asset_type, product_id: w.product_id });

    const unlinked = rowsOf<{ item_name: string; n: number }>(
        await db.execute(sql`
            SELECT item_name, count(*)::int AS n FROM invoice_line_items
             WHERE product_id IS NULL AND item_name IS NOT NULL
             GROUP BY 1`),
    );
    const groups = new Map<string, { asset_type: string | null; product_id: string; names: string[]; lines: number }>();
    for (const u of unlinked) {
        const p = productFor(mapped, u.item_name);
        if (!p.product_id) continue;
        const k = `${p.asset_type ?? ""}|${p.product_id}`;
        const g = groups.get(k) ?? { asset_type: p.asset_type, product_id: p.product_id, names: [], lines: 0 };
        g.names.push(u.item_name);
        g.lines += Number(u.n);
        groups.set(k, g);
    }

    let linesStamped = [...groups.values()].reduce((a, g) => a + g.lines, 0);
    if (apply) {
        linesStamped = await db.transaction(async (tx) => {
            for (const w of written.values()) {
                await tx.execute(sql`
                    INSERT INTO vyapar_item_map (item_key, item_name, asset_type, product_id, mapped_by)
                    VALUES (${w.family_key}, ${w.from_item}, ${w.asset_type}, ${w.product_id}, ${opts.actorId ?? null}::uuid)
                    ON CONFLICT (item_key) DO NOTHING`);
            }
            let n = 0;
            for (const g of groups.values()) {
                const res = rowsOf<{ n: number }>(
                    await tx.execute(sql`
                        WITH u AS (
                            UPDATE invoice_line_items SET asset_type = ${g.asset_type}, product_id = ${g.product_id},
                                   product_class = ${mappedClassSql(g.asset_type)}
                             WHERE product_id IS NULL
                               AND item_name IN (${sql.join(g.names.map((x) => sql`${x}`), sql`, `)})
                            RETURNING 1)
                        SELECT count(*)::int AS n FROM u`),
                );
                n += Number(res[0]?.n ?? 0);
            }
            return n;
        });
    }

    const byProduct = [...groups.values()]
        .map((g) => ({ asset_type: g.asset_type, product_id: g.product_id, lines: g.lines, spellings: new Set(g.names.map(itemKey)).size }))
        .sort((a, b) => b.lines - a.lines);
    return {
        families_written: [...written.values()],
        conflicts: [...others.entries()].map(([family_key, also]) => ({ family_key, kept: written.get(family_key)!.from_item, also: [...also] })),
        lines_stamped: linesStamped,
        spellings_stamped: byProduct.reduce((a, g) => a + g.spellings, 0),
        by_product: byProduct,
        applied: apply,
    };
}
