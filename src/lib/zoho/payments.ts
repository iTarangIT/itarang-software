// Pagination wrapper over Zoho Invoice `/customerpayments` endpoint.
//
// The invoice list (`/invoices`) carries no payment/UTR reference, so to surface
// the bank transaction id behind a paid invoice we pull customer payments and
// map each payment's reference_number onto the invoices it settled. Like the
// invoice sync, this does a full re-pull each run (small-business scale) and the
// caller stamps the latest payment per invoice into zoho_invoices.

import { zohoFetch } from "./client";
import type { ZohoListPaymentsResponse, ZohoPayment } from "./types";

export interface ListPaymentsOptions {
  page?: number;
  perPage?: number;
  /** Zoho organization to pull from. Defaults to the primary org. */
  organizationId?: string;
}

export async function listPaymentsPage(
  opts: ListPaymentsOptions,
): Promise<ZohoListPaymentsResponse> {
  const query: Record<string, string | number> = {
    page: opts.page ?? 1,
    per_page: opts.perPage ?? 200,
  };

  const res = await zohoFetch("/customerpayments", {
    method: "GET",
    query,
    organizationId: opts.organizationId,
  });
  return (await res.json()) as ZohoListPaymentsResponse;
}

export async function* iterateAllPayments(
  organizationId?: string,
): AsyncGenerator<ZohoPayment> {
  let page = 1;
  // Cap pages defensively — 200 pages * 200 per page = 40k payments/run.
  for (let i = 0; i < 200; i++) {
    const data = await listPaymentsPage({ page, organizationId });
    for (const pmt of data.customerpayments ?? []) {
      yield pmt;
    }
    if (!data.page_context?.has_more_page) return;
    page += 1;
  }
}
