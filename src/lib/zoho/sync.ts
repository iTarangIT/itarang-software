// Full-pull sync: Zoho Invoice v3 doesn't expose a modified-time filter,
// so each run pulls every invoice and upserts into zoho_invoices keyed on
// zoho_invoice_id. zoho_sync_state tracks last-run status for observability.
//
// Multi-org (E-171): the Zoho login owns more than one organization (Haryana +
// Delhi). We pull from every org returned by getOrganizationIds() into the one
// zoho_invoices table so the CEO dashboard totals are company-wide. Zoho
// invoice_id is globally unique across a login's orgs, so the upsert key holds.

import { and, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoInvoices, zohoSyncState } from "@/lib/db/schema";
import { iterateAllInvoices } from "./invoices";
import { iterateAllPayments } from "./payments";
import { getOrganizationIds } from "./client";
import type { ZohoInvoice, ZohoPayment } from "./types";

export interface SyncResult {
  upserted: number;
  durationMs: number;
  lastRunAt: string;
}

function parseInvoiceDate(s: string | undefined): string | null {
  if (!s) return null;
  // Zoho returns "YYYY-MM-DD" for dates — pass through as-is.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseAmount(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

export async function syncInvoicesSinceLastRun(): Promise<SyncResult> {
  const start = Date.now();

  // Ensure singleton state row exists (E-105 seeds it, but be defensive).
  await db
    .insert(zohoSyncState)
    .values({ id: 1 })
    .onConflictDoNothing({ target: zohoSyncState.id });

  let upserted = 0;

  try {
    for (const organizationId of getOrganizationIds()) {
      for await (const inv of iterateAllInvoices(organizationId)) {
        await upsertInvoice(inv, organizationId);
        upserted += 1;
      }
      // After invoices land, stamp each invoice with the reference of the
      // latest payment that settled it (E-174).
      for await (const pmt of iterateAllPayments(organizationId)) {
        await applyPaymentReference(pmt);
      }
    }

    const now = new Date();
    await db
      .update(zohoSyncState)
      .set({
        last_run_at: now,
        last_status: "ok",
        last_error: null,
      })
      .where(sql`id = 1`);

    return {
      upserted,
      durationMs: Date.now() - start,
      lastRunAt: now.toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(zohoSyncState)
      .set({
        last_run_at: new Date(),
        last_status: "error",
        last_error: msg.slice(0, 1000),
      })
      .where(sql`id = 1`);
    throw err;
  }
}

async function upsertInvoice(
  inv: ZohoInvoice,
  organizationId: string,
): Promise<void> {
  if (!inv.invoice_id) return;
  const now = new Date();
  await db
    .insert(zohoInvoices)
    .values({
      zoho_invoice_id: inv.invoice_id,
      organization_id: organizationId,
      invoice_number: inv.invoice_number ?? null,
      customer_id: inv.customer_id ?? null,
      customer_name: inv.customer_name ?? null,
      invoice_date: parseInvoiceDate(inv.date),
      due_date: parseInvoiceDate(inv.due_date),
      currency_code: inv.currency_code ?? null,
      total: parseAmount(inv.total),
      balance: parseAmount(inv.balance),
      status: inv.status ?? null,
      raw_json: inv as unknown as Record<string, unknown>,
      synced_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: zohoInvoices.zoho_invoice_id,
      set: {
        organization_id: organizationId,
        invoice_number: inv.invoice_number ?? null,
        customer_id: inv.customer_id ?? null,
        customer_name: inv.customer_name ?? null,
        invoice_date: parseInvoiceDate(inv.date),
        due_date: parseInvoiceDate(inv.due_date),
        currency_code: inv.currency_code ?? null,
        total: parseAmount(inv.total),
        balance: parseAmount(inv.balance),
        status: inv.status ?? null,
        raw_json: inv as unknown as Record<string, unknown>,
        synced_at: now,
        updated_at: now,
        // payment_* columns are owned by applyPaymentReference — don't reset
        // them here or each invoice re-pull would wipe the txn reference.
      },
    });
}

// Stamp a payment's reference (UTR / bank txn id) onto every invoice it
// settled, keeping the latest payment per invoice. The /customerpayments list
// links invoices via either an `invoices[]` array (invoice_id) or a comma-
// separated `invoice_numbers` string — handle both, falling back to numbers.
async function applyPaymentReference(pmt: ZohoPayment): Promise<void> {
  const paymentDate = parseInvoiceDate(pmt.date);
  if (!pmt.payment_id || !paymentDate) return;

  const ids = (pmt.invoices ?? [])
    .map((i) => i.invoice_id)
    .filter((v): v is string => !!v);

  const numbers =
    ids.length === 0 && typeof pmt.invoice_numbers === "string"
      ? (pmt.invoice_numbers as string)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  const match =
    ids.length > 0
      ? inArray(zohoInvoices.zoho_invoice_id, ids)
      : numbers.length > 0
        ? inArray(zohoInvoices.invoice_number, numbers)
        : null;
  if (!match) return;

  const now = new Date();
  await db
    .update(zohoInvoices)
    .set({
      payment_reference: pmt.reference_number ?? null,
      payment_id: pmt.payment_id,
      last_payment_date: paymentDate,
      updated_at: now,
    })
    .where(
      and(
        match,
        // Only overwrite when this payment is at least as recent as the one
        // already recorded, so the newest reference wins and re-runs are stable.
        sql`(${zohoInvoices.last_payment_date} IS NULL OR ${zohoInvoices.last_payment_date} <= ${paymentDate})`,
      ),
    );
}
