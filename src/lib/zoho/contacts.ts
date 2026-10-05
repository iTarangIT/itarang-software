// E-322 (tracker ID 70) — a Zoho customer's GSTIN, for the one-time backfill
// that lets Zoho-era invoices match a dealer account. One call per customer.
import { zohoFetch } from "./client";

export async function fetchContactGstin(
  customerId: string,
  organizationId?: string,
): Promise<string | null> {
  const res = await zohoFetch(`/contacts/${customerId}`, {
    method: "GET",
    organizationId,
  });
  const json = (await res.json()) as { contact?: { gst_no?: string } };
  return json.contact?.gst_no?.trim() || null;
}
