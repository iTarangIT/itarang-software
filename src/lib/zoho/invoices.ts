// Pagination wrapper over Zoho Invoice `/invoices` endpoint.
//
// Zoho Invoice v3 `/invoices` does not expose a `last_modified_time` query
// param and silently ignores `If-Modified-Since`. So we do a full re-pull
// each run and rely on the upsert in sync.ts (keyed on zoho_invoice_id) to
// keep zoho_invoices fresh. At small-business scale (≤ thousands of
// invoices) the cost is negligible — 5s per run, hourly.

import { zohoFetch } from "./client";
import type { ZohoInvoice, ZohoListInvoicesResponse } from "./types";

export interface ListInvoicesOptions {
  page?: number;
  perPage?: number;
  /** Zoho organization to pull from. Defaults to the primary org. */
  organizationId?: string;
}

export async function listInvoicesPage(
  opts: ListInvoicesOptions,
): Promise<ZohoListInvoicesResponse> {
  const query: Record<string, string | number> = {
    page: opts.page ?? 1,
    per_page: opts.perPage ?? 200,
  };

  const res = await zohoFetch("/invoices", {
    method: "GET",
    query,
    organizationId: opts.organizationId,
  });
  return (await res.json()) as ZohoListInvoicesResponse;
}

// Download a single invoice as a PDF from Zoho. `accept=pdf` makes the
// /invoices/{id} endpoint return the rendered tax-invoice PDF instead of JSON.
// organizationId is required for multi-org logins so Zoho resolves the invoice
// against the entity that actually owns it.
export async function fetchInvoicePdf(
  invoiceId: string,
  organizationId?: string,
): Promise<ArrayBuffer> {
  const res = await zohoFetch(`/invoices/${invoiceId}`, {
    method: "GET",
    query: { accept: "pdf" },
    organizationId,
  });
  return res.arrayBuffer();
}

/** A single line item on a Zoho invoice (the fields we surface). */
export interface ZohoInvoiceLineItem {
  name: string;
  description?: string;
  quantity: number;
  rate?: number;
  item_total?: number;
}

// Fetch a single invoice's full JSON detail — the ONLY place Zoho returns
// `line_items` (the list endpoint used by sync.ts omits them). Same endpoint as
// fetchInvoicePdf but WITHOUT `accept=pdf`, so Zoho returns JSON. Returns the
// line items, or [] when the invoice/detail can't be read.
export async function fetchInvoiceLineItems(
  invoiceId: string,
  organizationId?: string,
): Promise<ZohoInvoiceLineItem[]> {
  const res = await zohoFetch(`/invoices/${invoiceId}`, {
    method: "GET",
    organizationId,
  });
  const json = (await res.json()) as {
    invoice?: { line_items?: ZohoInvoiceLineItem[] };
  };
  return json.invoice?.line_items ?? [];
}

export async function* iterateAllInvoices(
  organizationId?: string,
): AsyncGenerator<ZohoInvoice> {
  let page = 1;
  // Cap pages defensively — 200 pages * 200 per page = 40k invoices/run.
  for (let i = 0; i < 200; i++) {
    const data = await listInvoicesPage({ page, organizationId });
    for (const inv of data.invoices ?? []) {
      yield inv;
    }
    if (!data.page_context?.has_more_page) return;
    page += 1;
  }
}
