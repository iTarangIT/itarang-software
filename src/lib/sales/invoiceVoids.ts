/**
 * E-322 (tracker ID 71 / handover P1-9) — voiding an invoice.
 *
 * Every Drive / Vyapar PDF was imported as 'sent' and nothing could mark it
 * cancelled, so a cancelled invoice stayed in revenue for its month. Now:
 *   * finance (finance_controller, CEO, Admin) voids it with a reason — logged
 *     in audit_logs;
 *   * the weekly Vyapar register import voids invoices it lists as cancelled
 *     (origin 'vyapar').
 * A void is a row in invoice_voids, never an edit of the invoice: zoho_invoices'
 * own status is rewritten by the hourly sync, and keeping the invoice intact
 * keeps the void reversible. revenueSource.ts reads a voided invoice as
 * status 'void', which every revenue reader already excludes.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { generateId } from "@/lib/api-utils";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Runner = typeof db | Tx;

export const VOIDABLE_SOURCES = ["zoho", "drive", "credit"] as const;
export type VoidableSource = (typeof VOIDABLE_SOURCES)[number];

export class InvoiceVoidError extends Error {
    readonly status: number;
    constructor(message: string, status = 400) {
        super(message);
        this.status = status;
    }
}

const TABLE: Record<VoidableSource, string> = {
    zoho: "zoho_invoices",
    drive: "sales_invoices",
    credit: "credit_notes",
};

async function assertExists(runner: Runner, source: VoidableSource, id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new InvoiceVoidError("Not an invoice id.");
    const rows = (await runner.execute(
        sql`SELECT 1 AS ok FROM ${sql.raw(TABLE[source])} WHERE id::text = ${id} LIMIT 1`,
    )) as unknown as Array<{ ok: number }>;
    if (!rows.length) throw new InvoiceVoidError("Invoice not found.", 404);
}

export async function voidInvoice(
    input: {
        source: VoidableSource;
        invoiceId: string;
        reason: string;
        origin: "manual" | "vyapar";
        actorId: string | null;
    },
    runner: Runner = db,
): Promise<{ voided: boolean }> {
    const reason = input.reason.trim();
    if (reason.length < 3) throw new InvoiceVoidError("Give a reason for voiding this invoice.");
    await assertExists(runner, input.source, input.invoiceId);
    const res = (await runner.execute(sql`
        INSERT INTO invoice_voids (source, invoice_id, reason, origin, voided_by)
        VALUES (${input.source}, ${input.invoiceId}, ${reason}, ${input.origin}, ${input.actorId}::uuid)
        ON CONFLICT (source, invoice_id) DO NOTHING
        RETURNING invoice_id
    `)) as unknown as Array<{ invoice_id: string }>;
    if (res.length && input.origin === "manual") {
        await runner.insert(auditLogs).values({
            id: await generateId("AUDIT"),
            entity_type: "invoice",
            entity_id: `${input.source}:${input.invoiceId}`,
            action: "invoice_void",
            performed_by: input.actorId,
            new_data: { reason, origin: input.origin },
        });
    }
    return { voided: res.length > 0 };
}

export async function unvoidInvoice(
    input: { source: VoidableSource; invoiceId: string; reason: string; actorId: string },
    runner: Runner = db,
): Promise<{ restored: boolean }> {
    const reason = input.reason.trim();
    if (reason.length < 3) throw new InvoiceVoidError("Give a reason for restoring this invoice.");
    const res = (await runner.execute(sql`
        DELETE FROM invoice_voids
         WHERE source = ${input.source} AND invoice_id = ${input.invoiceId}
        RETURNING reason, origin
    `)) as unknown as Array<{ reason: string; origin: string }>;
    if (res.length) {
        await runner.insert(auditLogs).values({
            id: await generateId("AUDIT"),
            entity_type: "invoice",
            entity_id: `${input.source}:${input.invoiceId}`,
            action: "invoice_unvoid",
            performed_by: input.actorId,
            old_data: res[0],
            new_data: { reason },
        });
    }
    return { restored: res.length > 0 };
}
