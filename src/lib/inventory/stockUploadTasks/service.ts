/**
 * Tracker ID 174 — "Stock to upload" tasks (E-348): create, check, close,
 * escalate. Rules: ./rules.ts.
 *
 *   recordInvoiceSerials()  called when a new Drive sales invoice's lines are
 *                           read (src/lib/sales/saveInvoiceLines.ts): stores
 *                           the battery serials and opens ONE task per
 *                           invoice, with a bell to the Inventory Manager,
 *                           Admin and partner.
 *   recheckStockTasks()     compares each open task's serials with the buyer
 *                           dealer's stock and closes the task when all are
 *                           in. Called after every stock upload and by the
 *                           hourly sweep.
 *   sweepStockTasks()       the hourly sweep (instrumentation-node.ts):
 *                           recheck, then escalate tasks past 2 working days
 *                           (bell to Admin and the CEO, once).
 *
 * Everything probes for E-348 first; on a database without it the invoice
 * scan and the uploads behave exactly as before. Times are compared with
 * Postgres now(), never the Node clock.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { loadHolidays } from "@/lib/calendar/holidays";
import { workingDaysDueAt } from "@/lib/calendar/officeCalendar";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";
import { GSTIN_KEY, accountsByGstinKey } from "@/lib/leads/gstinMatch";
import { emit } from "@/lib/notifications/emit";
import { SYSTEM_PARTY } from "@/lib/notifications/provenance";
import type { InvoiceLine } from "@/lib/sales/salesInvoiceLines";
import {
    STOCK_TASK_WORKING_DAYS,
    batterySerialLines,
    classifySerials,
    invoiceSerialTotals,
    normalizeSerial,
    stockTaskLine,
    stockTaskProgress,
    taskComplete,
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

// ── The buyer dealer ─────────────────────────────────────────────────────────

/**
 * The dealer account an invoice was sold to: a hand link in Invoice Ledger
 * (invoice_account_links) wins; "not a dealer sale" = none; otherwise the
 * account owning the Bill To GSTIN (accounts.gstin or account_gstins) — the
 * same match revenue uses (revenueSource.ts matchedUnion).
 */
export async function buyerAccountFor(invoiceId: string): Promise<string | null> {
    const key = GSTIN_KEY(sql`si.customer_gstin`);
    const rows = (await hasAccountOwnershipTables())
        ? await run(sql`
            WITH account_keys AS (${accountsByGstinKey()})
            SELECT CASE WHEN lk.kind = 'linked' THEN lk.account_id
                        WHEN lk.kind = 'not_dealer' THEN NULL
                        ELSE ak.account_id END AS account_id
              FROM sales_invoices si
              LEFT JOIN invoice_account_links lk ON lk.source = 'drive' AND lk.invoice_id = si.id::text
              LEFT JOIN account_keys ak ON lk.kind IS NULL AND ak.k = ${key}
             WHERE si.id::text = ${invoiceId}
             LIMIT 1`)
        : await run(sql`
            SELECT a.id AS account_id
              FROM sales_invoices si
              JOIN accounts a ON ${GSTIN_KEY(sql`a.gstin`)} = ${key}
             WHERE si.id::text = ${invoiceId}
             ORDER BY a.created_at ASC
             LIMIT 1`);
    const id = rows[0]?.account_id;
    return id == null ? null : String(id);
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Store the battery serials of a newly read invoice and open its task.
 * Best-effort by contract: never throws (the invoice is already saved).
 * Returns the new task id, or null (no battery line, task already there, or
 * no E-348).
 */
export async function recordInvoiceSerials(invoiceId: string, lines: readonly InvoiceLine[]): Promise<number | null> {
    try {
        const battery = batterySerialLines(lines);
        const { expected, serials } = invoiceSerialTotals(battery);
        if (expected <= 0) return null;
        if (!(await hasStockTaskTables())) return null;

        const values = battery.flatMap((l) => l.serials.map((s) => sql`('drive', ${invoiceId}, ${l.line_no}, ${s})`));
        if (values.length) {
            await db.execute(sql`
                INSERT INTO invoice_line_serials (invoice_source, invoice_id, line_no, serial_number)
                VALUES ${sql.join(values, sql`, `)}
                ON CONFLICT (invoice_source, invoice_id, serial_number) DO NOTHING`);
        }

        const [inv] = await run(sql`
            SELECT invoice_number, invoice_date::text AS invoice_date, customer_name, customer_gstin, now() AS db_now
              FROM sales_invoices WHERE id::text = ${invoiceId}`);
        if (!inv) return null;
        const accountId = await buyerAccountFor(invoiceId);
        const dbNow = new Date(String(inv.db_now));
        const dueAt = workingDaysDueAt(dbNow, STOCK_TASK_WORKING_DAYS, await loadHolidays());

        const [created] = await run(sql`
            INSERT INTO stock_upload_tasks
                (invoice_source, invoice_id, invoice_number, invoice_date, customer_name, customer_gstin,
                 account_id, expected_serials, read_serials, status, due_at)
            VALUES ('drive', ${invoiceId}, ${inv.invoice_number ?? null}, ${inv.invoice_date ?? null}::date,
                    ${inv.customer_name ?? null}, ${inv.customer_gstin ?? null}, ${accountId},
                    ${expected}, ${serials.length}, 'open', ${dueAt ? dueAt.toISOString() : null}::timestamptz)
            ON CONFLICT (invoice_source, invoice_id) DO NOTHING
            RETURNING id`);
        if (!created) return null;
        const taskId = Number(created.id);

        const label = `Invoice ${String(inv.invoice_number ?? "(no number)")} · ${String(inv.customer_name ?? "buyer unknown")}`;
        await emit({
            type: "stock_upload.task_created",
            title: "Stock to upload",
            message: `${label}: ${expected} batter${expected === 1 ? "y" : "ies"} to add to the dealer's stock.`,
            from: SYSTEM_PARTY,
            data: { taskId, invoiceId, accountId },
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
        SELECT t.id, t.invoice_id, t.invoice_number, t.invoice_date::text AS invoice_date, t.customer_name,
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
 * Re-check open / escalated tasks against stock; close the complete ones
 * ('auto'). Scope: given task ids, or every task of one buyer account, or all.
 * Returns how many closed. Never throws.
 */
export async function recheckStockTasks(scope: { taskIds?: number[]; accountId?: string | null } = {}): Promise<number> {
    try {
        if (!(await hasStockTaskTables())) return 0;
        const parts = [sql`t.status IN ('open', 'escalated')`];
        if (scope.taskIds?.length) parts.push(sql`t.id IN (${sql.join(scope.taskIds.map((id) => sql`${id}`), sql`, `)})`);
        if (scope.accountId) parts.push(sql`t.account_id = ${scope.accountId}`);
        const tasks = await loadTasks(sql.join(parts, sql` AND `));
        let closed = 0;
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
    const rows = await run(sql`
        UPDATE stock_upload_tasks
           SET status = 'escalated', escalated_at = now()
         WHERE status = 'open' AND due_at IS NOT NULL AND due_at < now()
         RETURNING id, invoice_number, customer_name, expected_serials, in_stock_serials`);
    for (const r of rows) {
        const id = Number(r.id);
        await emit({
            type: "stock_upload.task_overdue",
            title: "Stock to upload: overdue",
            message:
                `Invoice ${String(r.invoice_number ?? "(no number)")} · ${String(r.customer_name ?? "buyer unknown")}: ` +
                `${Number(r.in_stock_serials ?? 0)} of ${Number(r.expected_serials ?? 0)} batteries in the dealer's stock after ${STOCK_TASK_WORKING_DAYS} working days.`,
            from: SYSTEM_PARTY,
            data: { taskId: id },
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

