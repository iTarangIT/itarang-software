// Full-pull sync: Zoho Invoice v3 doesn't expose a modified-time filter,
// so each run pulls every invoice and upserts into zoho_invoices keyed on
// zoho_invoice_id. zoho_sync_state tracks last-run status for observability.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoInvoices, zohoSyncState } from "@/lib/db/schema";
import { iterateAllInvoices } from "./invoices";
import type { ZohoInvoice } from "./types";

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
    for await (const inv of iterateAllInvoices()) {
      await upsertInvoice(inv);
      upserted += 1;
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

async function upsertInvoice(inv: ZohoInvoice): Promise<void> {
  if (!inv.invoice_id) return;
  const now = new Date();
  await db
    .insert(zohoInvoices)
    .values({
      zoho_invoice_id: inv.invoice_id,
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
      },
    });
}
