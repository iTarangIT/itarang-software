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
}

export async function listInvoicesPage(
  opts: ListInvoicesOptions,
): Promise<ZohoListInvoicesResponse> {
  const query: Record<string, string | number> = {
    page: opts.page ?? 1,
    per_page: opts.perPage ?? 200,
  };

  const res = await zohoFetch("/invoices", { method: "GET", query });
  return (await res.json()) as ZohoListInvoicesResponse;
}

export async function* iterateAllInvoices(): AsyncGenerator<ZohoInvoice> {
  let page = 1;
  // Cap pages defensively — 200 pages * 200 per page = 40k invoices/run.
  for (let i = 0; i < 200; i++) {
    const data = await listInvoicesPage({ page });
    for (const inv of data.invoices ?? []) {
      yield inv;
    }
    if (!data.page_context?.has_more_page) return;
    page += 1;
  }
}
