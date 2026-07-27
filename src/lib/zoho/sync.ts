// Full-pull sync: Zoho Invoice v3 doesn't expose a modified-time filter,
// so each run pulls every invoice and upserts into zoho_invoices keyed on
// zoho_invoice_id. zoho_sync_state tracks last-run status for observability.
//
// Multi-org (E-171): the Zoho login owns more than one organization (Haryana
// "ITG" + Delhi "ITD"). We pull from every org resolveSyncOrganizationIds()
// resolves into the one zoho_invoices table so the CEO dashboard totals are
// company-wide. Zoho invoice_id is globally unique across a login's orgs, so
// the upsert key holds.

import { and, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoInvoices, zohoSyncState } from "@/lib/db/schema";
import { iterateAllInvoices } from "./invoices";
import { iterateAllPayments } from "./payments";
import { getOrganizationIds, listOrganizationIdsFromApi } from "./client";
import type { ZohoInvoice, ZohoPayment } from "./types";

export interface SyncResult {
  upserted: number;
  durationMs: number;
  lastRunAt: string;
  /** Orgs this run actually pulled from, and where that list came from. */
  organizationIds: string[];
  organizationSources: string;
  // "ok" = clean run, "partial" = some orgs/phases failed but invoices landed
  // for at least one org, "error" = every org's invoice pull failed.
  status: "ok" | "partial" | "error";
  // Per-org / per-phase failures that were tolerated (not aborted on). Empty on
  // a clean run. Also mirrored into zoho_sync_state.last_error for observability.
  errors: string[];
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Which orgs a run pulls from. Union of three sources — an org can only ever be
// ADDED here, never dropped, because a missing org is invisible in the UI (the
// CEO dashboard sums zoho_invoices unfiltered, so a dropped org just makes the
// company look smaller):
//   1. env — ZOHO_ORGANIZATION_IDS, else the single ZOHO_ORGANIZATION_ID.
//   2. db  — every org already present in zoho_invoices. Survives an env reset
//            and needs no extra Zoho scope; this is the source that re-attaches
//            Delhi (ITD) on prod, where shared/.env is regenerated from
//            PROD_ENV_FILE_B64 on each deploy and lost ZOHO_ORGANIZATION_IDS.
//   3. api — Zoho /organizations, so a newly created entity is picked up
//            without an env edit. Best-effort: a token whose scope doesn't
//            cover it must not break the sync.
// Set ZOHO_ORGANIZATION_DISCOVERY=0 to trust the env list alone (e.g. if the
// login ever owns an org whose invoices must NOT count as company revenue).
export async function resolveSyncOrganizationIds(): Promise<{
  ids: string[];
  sources: string;
}> {
  // Also asserts Zoho is configured at all — throws exactly as before if not.
  const envIds = getOrganizationIds();
  const ids = new Set(envIds);
  const sources = [`env=${envIds.join("+") || "none"}`];

  if (process.env.ZOHO_ORGANIZATION_DISCOVERY === "0") {
    return { ids: [...ids], sources: `${sources.join(" ")} discovery=off` };
  }

  try {
    const rows = await db
      .selectDistinct({ organization_id: zohoInvoices.organization_id })
      .from(zohoInvoices)
      .where(isNotNull(zohoInvoices.organization_id));
    const known = rows
      .map((r) => r.organization_id)
      .filter((v): v is string => !!v);
    const added = known.filter((id) => !ids.has(id));
    for (const id of known) ids.add(id);
    sources.push(`db=${known.length}${added.length ? `(+${added.join("+")})` : ""}`);
  } catch (err) {
    sources.push(`db=failed(${errMsg(err)})`);
  }

  try {
    const live = await listOrganizationIdsFromApi();
    const added = live.filter((id) => !ids.has(id));
    for (const id of live) ids.add(id);
    sources.push(`api=${live.length}${added.length ? `(+${added.join("+")})` : ""}`);
  } catch (err) {
    // Env + db still cover every org we've ever synced; only a brand-new org
    // would be missed. Recorded in the sources string so it stays diagnosable.
    sources.push(`api=failed(${errMsg(err)})`);
  }

  return { ids: [...ids], sources: sources.join(" ") };
}

async function recordSyncState(
  status: SyncResult["status"],
  error: string | null,
): Promise<void> {
  await db
    .update(zohoSyncState)
    .set({
      last_run_at: new Date(),
      last_status: status,
      last_error: error ? error.slice(0, 1000) : null,
    })
    .where(sql`id = 1`);
}

export async function syncInvoicesSinceLastRun(): Promise<SyncResult> {
  const start = Date.now();

  // Ensure singleton state row exists (E-105 seeds it, but be defensive).
  await db
    .insert(zohoSyncState)
    .values({ id: 1 })
    .onConflictDoNothing({ target: zohoSyncState.id });

  let upserted = 0;
  let orgsWithInvoices = 0; // orgs whose invoice pull completed cleanly
  const errors: string[] = [];
  let organizationIds: string[] = [];
  let organizationSources = "";

  try {
    ({ ids: organizationIds, sources: organizationSources } =
      await resolveSyncOrganizationIds());
    // Log the resolved set every run — a sync that quietly narrowed to one org
    // is precisely the failure this replaces, so it must be visible in the logs.
    console.log(
      `[zoho-sync] pulling ${organizationIds.length} org(s): ${organizationIds.join(", ")} [${organizationSources}]`,
    );

    for (const organizationId of organizationIds) {
      // Invoices are revenue-critical. Isolate each org so one org's failure
      // (bad token, transient 5xx) doesn't starve the others. On failure we
      // skip this org's payments too and move on to the next org.
      try {
        for await (const inv of iterateAllInvoices(organizationId)) {
          await upsertInvoice(inv, organizationId);
          upserted += 1;
        }
        orgsWithInvoices += 1;
      } catch (err) {
        const msg = `org ${organizationId} invoices: ${errMsg(err)}`;
        errors.push(msg);
        console.error(`[zoho-sync] ${msg}`);
        continue;
      }

      // Payments (E-174) only stamp a txn reference onto already-synced
      // invoices — pure enrichment. A failure here (e.g. the token lacks the
      // ZohoInvoice.customerpayments scope → 401) must NOT abort invoice
      // syncing or block other orgs, or CEO revenue totals silently go stale.
      try {
        for await (const pmt of iterateAllPayments(organizationId)) {
          await applyPaymentReference(pmt);
        }
      } catch (err) {
        const msg = `org ${organizationId} payments: ${errMsg(err)}`;
        errors.push(msg);
        console.error(
          `[zoho-sync] ${msg} — invoices for this org synced OK; payment references skipped this run`,
        );
      }
    }
  } catch (err) {
    // Failure outside the per-org guards (e.g. getOrganizationIds() config
    // assertion, or the DB itself). Record and propagate — this is unexpected.
    const msg = errMsg(err);
    await recordSyncState("error", msg);
    throw err;
  }

  const status: SyncResult["status"] =
    errors.length === 0 ? "ok" : orgsWithInvoices > 0 ? "partial" : "error";

  await recordSyncState(status, errors.length ? errors.join(" | ") : null);

  // Total failure (no org's invoices landed) still throws so the cron/admin
  // caller returns a 5xx and the failure stays alertable. Partial success
  // returns normally with the failures surfaced in `errors` + zoho_sync_state,
  // so a payments-scope 401 can no longer blank out the whole company's totals.
  if (status === "error") {
    throw new Error(`Zoho sync failed for all orgs: ${errors.join(" | ")}`);
  }

  return {
    upserted,
    durationMs: Date.now() - start,
    lastRunAt: new Date().toISOString(),
    organizationIds,
    organizationSources,
    status,
    errors,
  };
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
