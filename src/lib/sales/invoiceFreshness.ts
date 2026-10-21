/**
 * ID 171 — "Invoices read up to <date>" and the 3-working-day gap alert.
 *
 * Business (Kartik, 10 Oct): keep the Drive scan; show how far the invoice
 * data goes under every revenue and battery number, and alert Admin when no
 * new invoice has been read for 3 working days (office calendar, ID 85).
 *
 *   read_up_to    latest invoice date, Zoho or Drive / Vyapar, void excluded
 *   last_read_at  when the latest NEW invoice row was read (sales_invoices
 *                 created_at — the Drive scan and the Vyapar register import
 *                 both create rows there; Zoho is frozen)
 *
 * Cached for five minutes per process: it sits under several tiles.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { loadHolidays, loadOfficeCalendar } from "@/lib/calendar/holidays";
import { officeHoursResolver } from "@/lib/calendar/officeHoursStore";
import { workingDaysSince } from "@/lib/calendar/officeCalendar";
import { hasInvoiceLedgerTables } from "@/lib/sales/ledgerTables";
import { getTimeLimits } from "@/lib/timeLimits/store";
import { isStale, type InvoiceFreshness } from "./invoiceFreshnessRules";

export * from "./invoiceFreshnessRules";

const TTL_MS = 5 * 60_000;
let cached: { at: number; value: InvoiceFreshness } | null = null;

export async function invoiceFreshness(opts: { fresh?: boolean } = {}): Promise<InvoiceFreshness> {
    if (!opts.fresh && cached && Date.now() - cached.at < TTL_MS) return cached.value;
    const ledger = await hasInvoiceLedgerTables();
    const notVoid = (src: "zoho" | "drive", alias: string) =>
        ledger
            ? sql`AND NOT EXISTS (SELECT 1 FROM invoice_voids v WHERE v.source = ${src} AND v.invoice_id = ${sql.raw(alias)}.id::text)`
            : sql``;
    const [row] = (await db.execute(sql`
        SELECT GREATEST(
                 (SELECT MAX(zi.invoice_date) FROM zoho_invoices zi
                   WHERE COALESCE(zi.status, '') <> 'void' ${notVoid("zoho", "zi")}),
                 (SELECT MAX(si.invoice_date) FROM sales_invoices si
                   WHERE COALESCE(si.status, '') <> 'void' ${notVoid("drive", "si")})
               )::text AS read_up_to,
               (SELECT MAX(si.created_at) FROM sales_invoices si) AS last_read_at
    `)) as unknown as Array<{ read_up_to: string | null; last_read_at: string | Date | null }>;
    const [{ holidays, hours }, limits] = await Promise.all([loadOfficeCalendar(), getTimeLimits()]);
    const lastReadAt = row?.last_read_at ? new Date(row.last_read_at) : null;
    const since = lastReadAt ? workingDaysSince(lastReadAt, new Date(), holidays, hours) : null;
    const staleAfter = limits.invoice_stale_days;
    const value: InvoiceFreshness = {
        read_up_to: row?.read_up_to ? row.read_up_to.slice(0, 10) : null,
        last_read_at: lastReadAt ? lastReadAt.toISOString() : null,
        working_days_since_read: since,
        stale_after: staleAfter,
        stale: isStale(since, staleAfter),
    };
    cached = { at: Date.now(), value };
    return value;
}

/**
 * The once-a-day Admin alert: on a working day, when stale, a bell to every
 * admin — claimed per IST day in digest_runs (kind 'invoice_stale', as the
 * 08:30 scan does) so several processes or a restart never ring twice.
 */
export async function alertIfInvoicesStale(now = new Date()): Promise<"sent" | "fresh" | "not_working_day" | "already_sent"> {
    const { isWorkingDay, istDay } = await import("@/lib/calendar/officeCalendar");
    const day = istDay(now);
    if (!isWorkingDay(day, await loadHolidays(), await officeHoursResolver())) return "not_working_day";
    const f = await invoiceFreshness({ fresh: true });
    if (!f.stale) return "fresh";
    const claimed = (await db.execute(sql`
        INSERT INTO digest_runs (kind, digest_date, slot, status, attempts, triggered_by, recipients, claimed_at)
        VALUES ('invoice_stale', ${day}::date, 'morning', 'sent', 1, 'ticker', 'admin', now())
        ON CONFLICT (kind, digest_date, slot) WHERE slot IN ('morning', 'evening') DO NOTHING
        RETURNING id
    `)) as unknown as Array<{ id: number }>;
    if (claimed.length === 0) return "already_sent";
    const { staleAlertText } = await import("./invoiceFreshnessRules");
    const { notifyRoles } = await import("@/lib/notifications/notify");
    await notifyRoles(["admin"], {
        type: "invoices.stale",
        title: "No new invoice read",
        message: staleAlertText(f) ?? "No new invoice read.",
        data: { read_up_to: f.read_up_to, last_read_at: f.last_read_at, working_days: f.working_days_since_read, href: "/admin/reports/invoice-ledger" },
    });
    return "sent";
}
