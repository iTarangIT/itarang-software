/**
 * Tracker ID 174 — "Stock to upload" tasks (E-348): create, check, close,
 * escalate. Rules: ./rules.ts.
 *
 *   recordInvoiceSerials()  called whenever a sales invoice's lines come in:
 *                           the Drive scan (src/lib/sales/saveInvoiceLines.ts),
 *                           the Vyapar register import (vyaparImport.ts) and
 *                           Zoho (the hourly sync for a new invoice, and the
 *                           line backfill — ./zohoHook.ts). Stores the battery
 *                           serials and opens ONE task per invoice, with a
 *                           bell to the Inventory Manager, Admin and partner.
 *                           Drive and Vyapar share the sales_invoices row, so
 *                           the unique (invoice_source, invoice_id) key keeps
 *                           them to one task; a Zoho invoice whose number
 *                           already has a task (or the reverse) opens none.
 *   recheckStockTasks()     re-resolves each open task's buyer (Invoice Ledger
 *                           hand link, then Bill To GSTIN), closes tasks whose
 *                           invoice was voided or fully credit-noted, and
 *                           compares serials with the buyer's stock, closing
 *                           the task when all are in. Called after every
 *                           stock upload and by the hourly sweep.
 *   sweepStockTasks()       the hourly sweep (instrumentation-node.ts):
 *                           recheck, then escalate tasks past 2 working days
 *                           (bell to Admin and the CEO, once). An invoice
 *                           marked "not a dealer sale" never escalates.
 *   closeTasksForNotDealerSale()
 *                           Invoice Ledger's "Not a dealer sale" closes the
 *                           invoice's task at once (closed_how 'not_dealer');
 *                           recheckStockTasks() also closes any it finds.
 *
 * Everything probes for E-348 first; on a database without it the invoice
 * scan and the uploads behave exactly as before. Times are compared with
 * Postgres now(), never the Node clock.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { loadOfficeCalendar } from "@/lib/calendar/holidays";
import { workingDaysDueAt } from "@/lib/calendar/officeCalendar";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";
import { GSTIN_KEY, accountsByGstinKey } from "@/lib/leads/gstinMatch";
import { emit } from "@/lib/notifications/emit";
import { SYSTEM_PARTY } from "@/lib/notifications/provenance";
import { hasInvoiceLedgerTables } from "@/lib/sales/ledgerTables";
import { normalizeInvoiceNumber } from "@/lib/sales/normalizeInvoiceNumber";
import {
    STOCK_TASK_WORKING_DAYS,
    batterySerialLines,
    classifySerials,
    escalationMessage,
    importedInvoiceOpensTask,
    invoiceReversal,
    invoiceSerialTotals,
    normalizeSerial,
    notDealerSaleCloseNote,
    taskSourceOfLedger,
    stockTaskLine,
    stockTaskProgress,
    taskComplete,
    type LineForSerials,
    type SerialStatus,
    type StockTaskStatus,
} from "@/lib/inventory/stockUploadTasks/rules";

type Raw = Record<string, unknown>;
const run = async (q: SQL) => (await db.execute(q)) as unknown as Raw[];

/** Who hears of a new task: the Inventory Manager, Admin and partner (Chirag), decisions 1 and 5. */
export const STOCK_TASK_AUDIENCE = ["inventory_manager", "admin", "partner"];
/** Who hears of an escalation. */
export const STOCK_TASK_ESCALATION_AUDIENCE = ["admin", "ceo"];
/** Who may see the task list and close a task by hand. */
export const STOCK_TASK_ROLES = ["admin", "inventory_manager", "partner", "ceo"];

export const STOCK_TASKS_HREF = "/admin/inventory/stock-tasks";

// ── E-348 probe ───────────────────────────────────────────────────────────────

const PROBE_TTL_MS = 5 * 60_000;
let present: boolean | null = null;
let probedAt = 0;

export async function hasStockTaskTables(): Promise<boolean> {
    const now = Date.now();
    if (present !== null && now - probedAt < PROBE_TTL_MS) return present;
    try {
        const [r] = await run(sql`
            SELECT to_regclass('public.stock_upload_tasks') IS NOT NULL
               AND to_regclass('public.invoice_line_serials') IS NOT NULL AS ok`);
        present = Boolean(r?.ok);
    } catch {
        present = false;
    }
    probedAt = now;
    return present;
}

// ── The invoice and its buyer dealer ─────────────────────────────────────────

/**
 * Which invoice table a task points at. 'drive' = sales_invoices — invoices
 * the Drive scan read AND invoices the Vyapar register created or updated
 * (both write that table, and voids/links use 'drive' for it too); 'zoho' =
 * zoho_invoices.
 */
export type TaskInvoiceSource = "drive" | "zoho";

/** id, number, date, buyer name, Bill To GSTIN, total and Zoho status of every invoice of one source. */
async function invoiceRowsSql(source: TaskInvoiceSource): Promise<SQL> {
    if (source === "drive") {
        return sql`
            SELECT si.id::text AS id, si.invoice_number, si.invoice_date, si.customer_name,
                   si.customer_gstin AS gstin, si.total, NULL::text AS zoho_status
              FROM sales_invoices si`;
    }
    // Zoho's list payload carries no GSTIN: the E-322 backfill's
    // zoho_customer_gstins first, then raw_json (revenueSource.ts, same order).
    const gstins = await hasInvoiceLedgerTables();
    return gstins
        ? sql`
            SELECT zi.id::text AS id, zi.invoice_number, zi.invoice_date, zi.customer_name,
                   COALESCE(zcg.gstin, zi.raw_json->>'gst_no') AS gstin, zi.total, zi.status AS zoho_status
              FROM zoho_invoices zi
              LEFT JOIN zoho_customer_gstins zcg
                     ON zcg.organization_id = COALESCE(zi.organization_id, '') AND zcg.customer_id = zi.customer_id`
        : sql`
            SELECT zi.id::text AS id, zi.invoice_number, zi.invoice_date, zi.customer_name,
                   zi.raw_json->>'gst_no' AS gstin, zi.total, zi.status AS zoho_status
              FROM zoho_invoices zi`;
}

const inList = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

/**
 * The dealer account each invoice was sold to: a hand link in Invoice Ledger
 * (invoice_account_links) wins; "not a dealer sale" = none; otherwise the
 * account owning the Bill To GSTIN (accounts.gstin or account_gstins) — the
 * same match revenue uses (revenueSource.ts matchedUnion). Batch: invoice id
 * → account id (null = not linked). Ids absent from the result do not exist.
 */
export async function buyerAccountsFor(
    source: TaskInvoiceSource,
    invoiceIds: readonly string[],
): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (!invoiceIds.length) return out;
    const inv = await invoiceRowsSql(source);
    const key = GSTIN_KEY(sql`inv.gstin`);
    const rows = (await hasAccountOwnershipTables())
        ? await run(sql`
            WITH account_keys AS (${accountsByGstinKey()})
            SELECT inv.id,
                   CASE WHEN lk.kind = 'linked' THEN lk.account_id
                        WHEN lk.kind = 'not_dealer' THEN NULL
                        ELSE ak.account_id END AS account_id
              FROM (${inv}) inv
              LEFT JOIN invoice_account_links lk ON lk.source = ${source} AND lk.invoice_id = inv.id
              LEFT JOIN account_keys ak ON lk.kind IS NULL AND ak.k = ${key}
             WHERE inv.id IN (${inList(invoiceIds)})`)
        : await run(sql`
            SELECT inv.id,
                   (SELECT a.id FROM accounts a WHERE ${GSTIN_KEY(sql`a.gstin`)} = ${key}
                     ORDER BY a.created_at ASC LIMIT 1) AS account_id
              FROM (${inv}) inv
             WHERE inv.id IN (${inList(invoiceIds)})`);
    for (const r of rows) out.set(String(r.id), r.account_id == null ? null : String(r.account_id));
    return out;
}

/** One invoice's buyer dealer (see buyerAccountsFor). */
export async function buyerAccountFor(invoiceId: string, source: TaskInvoiceSource = "drive"): Promise<string | null> {
    return (await buyerAccountsFor(source, [invoiceId])).get(invoiceId) ?? null;
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Where the lines came from. 'drive_scan' is a newly read Drive file; the
 * others are imports, which open a task only for invoices dated from the day
 * tasks went live (importedInvoiceOpensTask).
 */
export type InvoiceLinesOrigin = "drive_scan" | "vyapar" | "zoho";

/** Does another source already hold a task for the same invoice number? */
async function sameNumberTaskElsewhere(source: TaskInvoiceSource, invoiceNumber: unknown): Promise<boolean> {
    const key = normalizeInvoiceNumber(invoiceNumber == null ? null : String(invoiceNumber));
    if (!key) return false;
    const rows = await run(sql`
        SELECT invoice_number FROM stock_upload_tasks
         WHERE invoice_source <> ${source} AND invoice_number IS NOT NULL`);
    return rows.some((r) => normalizeInvoiceNumber(String(r.invoice_number)) === key);
}

/**
 * Store the battery serials of a newly read invoice and open its task.
 * Serials: those the line reader returned, else the ones printed in the line
 * description ("Serial No: …"). A battery invoice with no readable serials
 * still opens a task: it shows "serials not read" and cannot close by itself.
 *
 * Seen again (a Vyapar register re-listing a Drive invoice): no second task —
 * new serials are added to the open one. Best-effort by contract: never
 * throws (the invoice is already saved). Returns the new task id, or null
 * (no battery line, task already there, an old imported invoice, or no E-348).
 */
export async function recordInvoiceSerials(
    invoiceId: string,
    lines: readonly LineForSerials[],
    opts: { source?: TaskInvoiceSource; origin?: InvoiceLinesOrigin } = {},
): Promise<number | null> {
    const source = opts.source ?? "drive";
    const origin = opts.origin ?? "drive_scan";
    try {
        const battery = batterySerialLines(lines);
        if (!battery.length) return null;
        const { expected, serials } = invoiceSerialTotals(battery);
        if (!(await hasStockTaskTables())) return null;

        const [inv] = await run(sql`
            SELECT inv.invoice_number, inv.invoice_date::text AS invoice_date, inv.customer_name, inv.gstin,
                   now() AS db_now
              FROM (${await invoiceRowsSql(source)}) inv
             WHERE inv.id = ${invoiceId}`);
        if (!inv) return null;
        if (origin !== "drive_scan" && !importedInvoiceOpensTask(inv.invoice_date == null ? null : String(inv.invoice_date))) {
            return null;
        }

        const [existing] = await run(sql`
            SELECT id, status FROM stock_upload_tasks WHERE invoice_source = ${source} AND invoice_id = ${invoiceId}`);
        if (!existing && (await sameNumberTaskElsewhere(source, inv.invoice_number))) return null;

        const values = battery.flatMap((l) => l.serials.map((s) => sql`(${source}, ${invoiceId}, ${l.line_no}, ${s})`));
        if (values.length) {
            await db.execute(sql`
                INSERT INTO invoice_line_serials (invoice_source, invoice_id, line_no, serial_number)
                VALUES ${sql.join(values, sql`, `)}
                ON CONFLICT (invoice_source, invoice_id, serial_number) DO NOTHING`);
        }

        if (existing) {
            // The same invoice read again: one task, with every serial seen.
            if (String(existing.status) !== "closed") {
                await db.execute(sql`
                    UPDATE stock_upload_tasks
                       SET expected_serials = GREATEST(expected_serials, ${expected}),
                           read_serials = (SELECT count(*)::int FROM invoice_line_serials s
                                            WHERE s.invoice_source = ${source} AND s.invoice_id = ${invoiceId})
                     WHERE id = ${Number(existing.id)}`);
                await recheckStockTasks({ taskIds: [Number(existing.id)] });
            }
            return null;
        }

        const accountId = (await buyerAccountsFor(source, [invoiceId])).get(invoiceId) ?? null;
        const dbNow = new Date(String(inv.db_now));
        const { holidays, hours } = await loadOfficeCalendar();
        const dueAt = workingDaysDueAt(dbNow, STOCK_TASK_WORKING_DAYS, holidays, hours);

        const [created] = await run(sql`
            INSERT INTO stock_upload_tasks
                (invoice_source, invoice_id, invoice_number, invoice_date, customer_name, customer_gstin,
                 account_id, expected_serials, read_serials, status, due_at)
            VALUES (${source}, ${invoiceId}, ${inv.invoice_number ?? null}, ${inv.invoice_date ?? null}::date,
                    ${inv.customer_name ?? null}, ${inv.gstin == null ? null : String(inv.gstin).slice(0, 20)}, ${accountId},
                    ${expected}, ${serials.length}, 'open', ${dueAt ? dueAt.toISOString() : null}::timestamptz)
            ON CONFLICT (invoice_source, invoice_id) DO NOTHING
            RETURNING id`);
        if (!created) return null;
        const taskId = Number(created.id);

        const label = `Invoice ${String(inv.invoice_number ?? "(no number)")} · ${String(inv.customer_name ?? "buyer unknown")}`;
        await emit({
            type: "stock_upload.task_created",
            title: "Stock to upload",
            message:
                expected > 0
                    ? `${label}: ${expected} batter${expected === 1 ? "y" : "ies"} to add to the dealer's stock.`
                    : `${label}: batteries to add to the dealer's stock (serials not read from the invoice).`,
            from: SYSTEM_PARTY,
            data: { taskId, invoiceId, invoiceSource: source, accountId },
            to: [{ audience: { kind: "roles", roles: STOCK_TASK_AUDIENCE }, as: SYSTEM_PARTY, href: `${STOCK_TASKS_HREF}#task-${taskId}` }],
        });

        // The stock may already be there (uploaded before the invoice was read).
        await recheckStockTasks({ taskIds: [taskId] });
        return taskId;
    } catch (e) {
        console.warn("[stock-tasks] could not record invoice serials:", e instanceof Error ? e.message : e);
        return null;
    }
}

// ── Check / close ────────────────────────────────────────────────────────────

export type TaskSerial = { serial: string; status: SerialStatus; dealerId: string | null; dealerName: string | null };

export type StockTask = {
    id: number;
    invoiceSource: TaskInvoiceSource;
    invoiceId: string;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    customerName: string | null;
    customerGstin: string | null;
    accountId: string | null;
    accountName: string | null;
    expected: number;
    status: StockTaskStatus;
    dueAt: string | null;
    overdue: boolean;
    createdAt: string;
    closedAt: string | null;
    closedHow: string | null;
    closeNote: string | null;
    serials: TaskSerial[];
    progress: string;
};

/** Where each serial sits in stock: normalized serial → dealer (null = no dealer). */
async function stockBySerial(serials: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (!serials.length) return out;
    const rows = await run(sql`
        SELECT upper(regexp_replace(serial_number, '\\s', '', 'g')) AS s, dealer_id
          FROM inventory
         WHERE upper(regexp_replace(serial_number, '\\s', '', 'g')) IN (${sql.join(serials.map((s) => sql`${s}`), sql`, `)})`);
    for (const r of rows) {
        const s = normalizeSerial(r.s);
        if (s) out.set(s, r.dealer_id == null ? null : String(r.dealer_id));
    }
    return out;
}

async function loadTasks(where: SQL): Promise<StockTask[]> {
    const rows = await run(sql`
        SELECT t.id, t.invoice_source, t.invoice_id, t.invoice_number, t.invoice_date::text AS invoice_date, t.customer_name,
               t.customer_gstin, t.account_id, a.business_entity_name AS account_name, t.expected_serials,
               t.status, t.due_at, t.created_at, t.closed_at, t.closed_how, t.close_note,
               (t.status <> 'closed' AND t.due_at IS NOT NULL AND t.due_at < now()) AS overdue,
               COALESCE((SELECT array_agg(s.serial_number ORDER BY s.line_no, s.id)
                           FROM invoice_line_serials s
                          WHERE s.invoice_source = t.invoice_source AND s.invoice_id = t.invoice_id), '{}') AS serials
          FROM stock_upload_tasks t
          LEFT JOIN accounts a ON a.id = t.account_id
         WHERE ${where}
         ORDER BY (t.status = 'closed'), t.due_at ASC NULLS LAST, t.id DESC
         LIMIT 500`);
    const all = [...new Set(rows.flatMap((r) => ((r.serials as string[]) ?? []).map((s) => normalizeSerial(s)).filter((s): s is string => !!s)))];
    const stock = await stockBySerial(all);
    const dealerIds = [...new Set([...stock.values()].filter((v): v is string => !!v))];
    const names = new Map<string, string>();
    if (dealerIds.length) {
        const n = await run(sql`SELECT id, business_entity_name FROM accounts WHERE id IN (${sql.join(dealerIds.map((d) => sql`${d}`), sql`, `)})`);
        for (const r of n) names.set(String(r.id), String(r.business_entity_name ?? r.id));
    }
    return rows.map((r) => {
        const accountId = r.account_id == null ? null : String(r.account_id);
        const serials = ((r.serials as string[]) ?? []).map((s) => normalizeSerial(s)).filter((s): s is string => !!s);
        const classified = classifySerials(serials, stock, accountId).map((c) => ({
            ...c,
            dealerName: c.dealerId ? names.get(c.dealerId) ?? c.dealerId : null,
        }));
        const expected = Number(r.expected_serials ?? 0);
        return {
            id: Number(r.id),
            invoiceSource: String(r.invoice_source) === "zoho" ? "zoho" : "drive",
            invoiceId: String(r.invoice_id),
            invoiceNumber: r.invoice_number == null ? null : String(r.invoice_number),
            invoiceDate: r.invoice_date == null ? null : String(r.invoice_date),
            customerName: r.customer_name == null ? null : String(r.customer_name),
            customerGstin: r.customer_gstin == null ? null : String(r.customer_gstin),
            accountId,
            accountName: r.account_name == null ? null : String(r.account_name),
            expected,
            status: String(r.status) as StockTaskStatus,
            dueAt: r.due_at == null ? null : new Date(String(r.due_at)).toISOString(),
            overdue: Boolean(r.overdue),
            createdAt: new Date(String(r.created_at)).toISOString(),
            closedAt: r.closed_at == null ? null : new Date(String(r.closed_at)).toISOString(),
            closedHow: r.closed_how == null ? null : String(r.closed_how),
            closeNote: r.close_note == null ? null : String(r.close_note),
            serials: classified,
            progress: stockTaskProgress({
                expected,
                read: serials.length,
                inStock: classified.filter((c) => c.status === "in_stock").length,
                otherDealer: classified.filter((c) => c.status === "other_dealer").length,
                buyerKnown: !!accountId,
            }),
        };
    });
}

/**
 * Voided or fully credit-noted invoices among these tasks: task id → close
 * note (rules.ts invoiceReversal). Void = a row in invoice_voids (a Vyapar
 * cancellation writes one too) or Zoho's own status 'void'. Credit notes are
 * matched on their "against invoice" number (normalizeInvoiceNumber).
 */
export async function reversedTasks(
    tasks: ReadonlyArray<Pick<StockTask, "id" | "invoiceSource" | "invoiceId" | "invoiceNumber">>,
): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (!tasks.length) return out;
    const ledger = await hasInvoiceLedgerTables();

    const voided = new Set<string>(); // `${source}:${invoiceId}`
    const totals = new Map<string, { total: number | null; zohoStatus: string | null }>();
    for (const source of ["drive", "zoho"] as const) {
        const ids = tasks.filter((t) => t.invoiceSource === source).map((t) => t.invoiceId);
        if (!ids.length) continue;
        const rows = await run(sql`
            SELECT inv.id, inv.total, inv.zoho_status FROM (${await invoiceRowsSql(source)}) inv
             WHERE inv.id IN (${inList(ids)})`);
        for (const r of rows) {
            totals.set(`${source}:${String(r.id)}`, {
                total: r.total == null ? null : Number(r.total),
                zohoStatus: r.zoho_status == null ? null : String(r.zoho_status),
            });
        }
        if (ledger) {
            const v = await run(sql`
                SELECT invoice_id FROM invoice_voids WHERE source = ${source} AND invoice_id IN (${inList(ids)})`);
            for (const r of v) voided.add(`${source}:${String(r.invoice_id)}`);
        }
    }

    // Credit notes (not themselves voided) by the invoice number they reverse.
    const credited = new Map<string, { sum: number; notes: string[] }>();
    if (ledger) {
        const notes = await run(sql`
            SELECT cn.note_number, cn.against_invoice_number, cn.total
              FROM credit_notes cn
              LEFT JOIN invoice_voids cv ON cv.source = 'credit' AND cv.invoice_id = cn.id::text
             WHERE cv.invoice_id IS NULL AND cn.against_invoice_number IS NOT NULL`);
        for (const n of notes) {
            const key = normalizeInvoiceNumber(String(n.against_invoice_number));
            if (!key) continue;
            const c = credited.get(key) ?? { sum: 0, notes: [] };
            c.sum += Number(n.total ?? 0);
            if (n.note_number != null) c.notes.push(String(n.note_number));
            credited.set(key, c);
        }
    }

    for (const t of tasks) {
        const k = `${t.invoiceSource}:${t.invoiceId}`;
        const inv = totals.get(k);
        const c = credited.get(normalizeInvoiceNumber(t.invoiceNumber) ?? "") ?? { sum: 0, notes: [] };
        const note = invoiceReversal({
            voided: voided.has(k) || (inv?.zohoStatus ?? "").toLowerCase() === "void",
            invoiceTotal: inv?.total ?? null,
            credited: c.sum,
            creditNotes: c.notes,
        });
        if (note) out.set(t.id, note);
    }
    return out;
}

/**
 * Tasks whose invoice is marked "not a dealer sale" in Invoice Ledger
 * (invoice_account_links kind 'not_dealer'): task id → who marked it and the
 * close note. Empty without E-321.
 */
async function notDealerTasks(
    tasks: ReadonlyArray<Pick<StockTask, "id" | "invoiceSource" | "invoiceId">>,
): Promise<Map<number, { by: string | null; note: string }>> {
    const out = new Map<number, { by: string | null; note: string }>();
    if (!tasks.length || !(await hasAccountOwnershipTables())) return out;
    for (const source of ["drive", "zoho"] as const) {
        const mine = tasks.filter((t) => t.invoiceSource === source);
        if (!mine.length) continue;
        const rows = await run(sql`
            SELECT invoice_id, linked_by::text AS linked_by, note
              FROM invoice_account_links
             WHERE source = ${source} AND kind = 'not_dealer'
               AND invoice_id IN (${inList([...new Set(mine.map((t) => t.invoiceId))])})`);
        const byInvoice = new Map(rows.map((r) => [String(r.invoice_id), r]));
        for (const t of mine) {
            const r = byInvoice.get(t.invoiceId);
            if (!r) continue;
            out.set(t.id, {
                by: r.linked_by == null ? null : String(r.linked_by),
                note: notDealerSaleCloseNote(r.note == null ? null : String(r.note)),
            });
        }
    }
    return out;
}

/**
 * Invoice Ledger marked this invoice "not a dealer sale": close its open task
 * now, with the reason (ID 174 item 2). Ledger source 'credit' has no task.
 * Returns how many closed (0 or 1). Never throws — the mark itself is saved
 * already, and the hourly recheck closes the task anyway.
 */
export async function closeTasksForNotDealerSale(input: {
    source: string;
    invoiceId: string;
    userId: string | null;
    note: string | null;
}): Promise<number> {
    try {
        const source = taskSourceOfLedger(input.source);
        if (!source || !(await hasStockTaskTables())) return 0;
        const rows = await run(sql`
            UPDATE stock_upload_tasks
               SET status = 'closed', closed_at = now(), closed_how = 'not_dealer',
                   closed_by = ${input.userId}, close_note = ${notDealerSaleCloseNote(input.note)},
                   last_checked_at = now()
             WHERE invoice_source = ${source} AND invoice_id = ${input.invoiceId}
               AND status IN ('open', 'escalated')
             RETURNING id`);
        return rows.length;
    } catch (e) {
        console.warn("[stock-tasks] not-a-dealer-sale close failed:", e instanceof Error ? e.message : e);
        return 0;
    }
}

/**
 * Re-resolve the buyer of each task (an Invoice Ledger hand link or a GSTIN
 * added to an account after the invoice was read). Returns whether any changed.
 */
async function refreshBuyers(tasks: readonly StockTask[]): Promise<boolean> {
    let changed = false;
    for (const source of ["drive", "zoho"] as const) {
        const mine = tasks.filter((t) => t.invoiceSource === source);
        if (!mine.length) continue;
        const buyers = await buyerAccountsFor(source, [...new Set(mine.map((t) => t.invoiceId))]);
        for (const t of mine) {
            if (!buyers.has(t.invoiceId)) continue; // invoice row gone: keep what the task had
            const now = buyers.get(t.invoiceId) ?? null;
            if (now === t.accountId) continue;
            await db.execute(sql`UPDATE stock_upload_tasks SET account_id = ${now} WHERE id = ${t.id}`);
            changed = true;
        }
    }
    return changed;
}

/**
 * Re-check open / escalated tasks: close those whose invoice was voided or
 * fully credit-noted ('voided'), re-resolve each buyer, then compare serials
 * with the buyer's stock and close the complete ones ('auto'). Scope: given
 * task ids, or the tasks of one buyer account (plus those with no buyer yet,
 * which that upload may be for), or all. Returns how many closed. Never throws.
 */
export async function recheckStockTasks(scope: { taskIds?: number[]; accountId?: string | null } = {}): Promise<number> {
    try {
        if (!(await hasStockTaskTables())) return 0;
        const parts = [sql`t.status IN ('open', 'escalated')`];
        if (scope.taskIds?.length) parts.push(sql`t.id IN (${sql.join(scope.taskIds.map((id) => sql`${id}`), sql`, `)})`);
        if (scope.accountId) parts.push(sql`(t.account_id = ${scope.accountId} OR t.account_id IS NULL)`);
        const where = sql.join(parts, sql` AND `);
        let tasks = await loadTasks(where);
        let closed = 0;

        const gone = await reversedTasks(tasks);
        for (const [id, note] of gone) {
            const done = await run(sql`
                UPDATE stock_upload_tasks
                   SET status = 'closed', closed_at = now(), closed_how = 'voided', close_note = ${note},
                       last_checked_at = now()
                 WHERE id = ${id} AND status IN ('open', 'escalated')
                 RETURNING id`);
            closed += done.length;
        }
        tasks = tasks.filter((t) => !gone.has(t.id));

        // ID 174 item 2: an invoice marked "not a dealer sale" will never be
        // stocked by a dealer — close its task with the reason.
        const notDealer = await notDealerTasks(tasks);
        for (const [id, mark] of notDealer) {
            const done = await run(sql`
                UPDATE stock_upload_tasks
                   SET status = 'closed', closed_at = now(), closed_how = 'not_dealer',
                       closed_by = ${mark.by}::uuid, close_note = ${mark.note}, last_checked_at = now()
                 WHERE id = ${id} AND status IN ('open', 'escalated')
                 RETURNING id`);
            closed += done.length;
        }
        tasks = tasks.filter((t) => !notDealer.has(t.id));

        if (await refreshBuyers(tasks)) {
            const ids = tasks.map((t) => t.id);
            tasks = ids.length ? await loadTasks(sql`t.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`) : [];
        }

        for (const t of tasks) {
            const inStock = t.serials.filter((s) => s.status === "in_stock").length;
            if (taskComplete({ buyerAccountId: t.accountId, expected: t.expected, statuses: t.serials })) {
                const done = await run(sql`
                    UPDATE stock_upload_tasks
                       SET status = 'closed', closed_at = now(), closed_how = 'auto', in_stock_serials = ${inStock},
                           last_checked_at = now()
                     WHERE id = ${t.id} AND status IN ('open', 'escalated')
                     RETURNING id`);
                closed += done.length;
            } else {
                await db.execute(sql`
                    UPDATE stock_upload_tasks SET in_stock_serials = ${inStock}, last_checked_at = now()
                     WHERE id = ${t.id}`);
            }
        }
        return closed;
    } catch (e) {
        console.warn("[stock-tasks] recheck failed:", e instanceof Error ? e.message : e);
        return 0;
    }
}

/** After a stock upload to `dealerId`: re-check that buyer's open tasks. Never throws. */
export async function recheckAfterStockUpload(dealerId: string): Promise<void> {
    await recheckStockTasks({ accountId: dealerId });
}

// ── Escalate ─────────────────────────────────────────────────────────────────

/**
 * The hourly sweep: re-check every open task, then escalate those still open
 * past their due time. The UPDATE … RETURNING claims each escalation, so two
 * processes never ring twice.
 */
export async function sweepStockTasks(): Promise<{ closed: number; escalated: number }> {
    if (!(await hasStockTaskTables())) return { closed: 0, escalated: 0 };
    const closed = await recheckStockTasks();
    // ID 174 item 2: never escalate (as "buyer not linked" or otherwise) an
    // invoice marked "not a dealer sale" — even if the recheck above failed.
    const notDealer = (await hasAccountOwnershipTables())
        ? sql`AND NOT EXISTS (SELECT 1 FROM invoice_account_links lk
                               WHERE lk.source = stock_upload_tasks.invoice_source
                                 AND lk.invoice_id = stock_upload_tasks.invoice_id
                                 AND lk.kind = 'not_dealer')`
        : sql``;
    const rows = await run(sql`
        UPDATE stock_upload_tasks
           SET status = 'escalated', escalated_at = now()
         WHERE status = 'open' AND due_at IS NOT NULL AND due_at < now()
           ${notDealer}
         RETURNING id, invoice_number, customer_name, expected_serials, in_stock_serials, account_id`);
    for (const r of rows) {
        const id = Number(r.id);
        // A task whose buyer is still not linked escalates too, but says so:
        // the fix is a link in Invoice Ledger, not a stock upload.
        const buyerKnown = r.account_id != null;
        await emit({
            type: "stock_upload.task_overdue",
            title: buyerKnown ? "Stock to upload: overdue" : "Stock to upload: buyer not linked",
            message: escalationMessage({
                invoiceNumber: r.invoice_number == null ? null : String(r.invoice_number),
                customerName: r.customer_name == null ? null : String(r.customer_name),
                inStock: Number(r.in_stock_serials ?? 0),
                expected: Number(r.expected_serials ?? 0),
                buyerKnown,
            }),
            from: SYSTEM_PARTY,
            data: { taskId: id, reason: buyerKnown ? "overdue" : "buyer_not_linked" },
            to: [{ audience: { kind: "roles", roles: STOCK_TASK_ESCALATION_AUDIENCE }, as: SYSTEM_PARTY, href: `${STOCK_TASKS_HREF}#task-${id}` }],
        });
    }
    return { closed, escalated: rows.length };
}

// ── Read / close by hand ─────────────────────────────────────────────────────

export async function listStockTasks(filter: "open" | "closed" | "all" = "open"): Promise<StockTask[] | null> {
    if (!(await hasStockTaskTables())) return null;
    const where =
        filter === "open" ? sql`t.status IN ('open', 'escalated')` : filter === "closed" ? sql`t.status = 'closed'` : sql`TRUE`;
    return loadTasks(where);
}

/** Open and overdue counts, for the daily email and the Needs-action tile. Null without E-348. */
export async function stockTaskCounts(): Promise<{ open: number; overdue: number; line: string } | null> {
    if (!(await hasStockTaskTables())) return null;
    const [r] = await run(sql`
        SELECT count(*)::int AS open,
               count(*) FILTER (WHERE due_at IS NOT NULL AND due_at < now())::int AS overdue
          FROM stock_upload_tasks WHERE status IN ('open', 'escalated')`);
    const open = Number(r?.open ?? 0);
    const overdue = Number(r?.overdue ?? 0);
    return { open, overdue, line: stockTaskLine(open, overdue) };
}

/** Close a task by hand (e.g. the invoice was cancelled), with a note. */
export async function closeStockTaskByHand(id: number, userId: string, note: string): Promise<boolean> {
    if (!(await hasStockTaskTables())) return false;
    const rows = await run(sql`
        UPDATE stock_upload_tasks
           SET status = 'closed', closed_at = now(), closed_how = 'by_hand', closed_by = ${userId}, close_note = ${note}
         WHERE id = ${id} AND status IN ('open', 'escalated')
         RETURNING id`);
    return rows.length > 0;
}

