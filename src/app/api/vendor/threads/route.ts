/**
 * GET /api/vendor/threads
 *
 * The lots iTarang has quoted to the CALLING vendor (E-195, BRD M24).
 *
 * Two redaction boundaries, both of which have to hold:
 *
 *   1. threadsForVendor() scopes by the vendor's own accounts.id IN THE QUERY,
 *      and selects no dealer identity and no dealer-side price to begin with.
 *   2. toVendorThread() rebuilds the payload field-by-field, so a column added
 *      to that query later cannot ride out to a vendor by default.
 *
 * Belt and braces on purpose. iTarang is a back-to-back principal: it buys the
 * lot from a dealer and sells it to the vendor, and the difference is the whole
 * business. A vendor who can identify the dealer can go around us next time; a
 * vendor who learns what we paid knows our margin exactly. Neither is a privacy
 * nicety — they are the revenue.
 *
 * Note what is absent: the DEAL's status. A vendor sees their own thread's
 * status and nothing else. `DEALER_ACCEPTED` or `MARGIN_SET` would tell them we
 * had already bought the lot and roughly when, which is a negotiating position.
 */

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireVendor } from "@/lib/buyback/auth";
import { toVendorThread } from "@/lib/buyback/serialize";
import { threadsForVendor } from "@/lib/buyback/vendors";

export const runtime = "nodejs";

export const GET = withErrorHandler(async () => {
  const actor = await requireVendor();

  const rows = await threadsForVendor(actor.entityId!);

  const threads = rows.map((t) =>
    toVendorThread({
      thread_id: t.thread_id,
      quotation_no: t.quotation_no ?? "—",
      status: t.status,
      pickup_city: t.pickup_city,
      pickup_state: t.pickup_state,
      sent_at: t.sent_at,
      responded_at: t.responded_at,
      has_vendor_po: t.has_vendor_po,
      proforma: t.proforma,
      lines: t.lines.map((l) => ({
        line_id: l.line_id,
        quantity: l.quantity,
        condition: l.condition,
        voltage: l.voltage,
        ah: l.ah,
        ask_price: l.ask_price,
        counter_price: l.counter_price,
        agreed_price: l.agreed_price,
      })),
    }),
  );

  return successResponse({ threads });
});
