/**
 * POST /api/admin/buyback/requests/:id/routing   (BRD M09, "POST /:id/route")
 *
 * MARGIN_SET → VENDOR_ROUTED. Quotes the lot to N scrap vendors: renders one
 * MASKED quotation PDF per vendor, opens a thread per vendor, and emits one
 * EMAIL event per vendor for the dispatcher to send.
 *
 * WHY THE PDFs ARE RENDERED BEFORE THE TRANSACTION:
 * Puppeteer takes seconds. Holding a Postgres transaction open across N of them
 * would keep a FOR UPDATE lock on the deal for the duration and pin a connection
 * from the pool. So the documents are built and uploaded first, then one short
 * transaction inserts the threads and moves the state. If someone else moves the
 * deal in between, the optimistic status guard inside applyTransition rejects us
 * with a 409 and the uploaded PDFs are orphaned in S3 — a few stray objects is a
 * far cheaper failure than a lock held across a browser render.
 *
 * WHAT MAKES THE MASKING SAFE (M09 AC — "PDF contains no dealer name/phone/GST"):
 * the template is handed a VendorQuotationView, which is built field-by-field by
 * toVendorQuotation() and has no dealer identity on it at all. The PDF cannot
 * name the dealer because nothing in scope knows who they are.
 */

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { vendorThreadLines, vendorThreads } from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError, TransitionError, ValidationError } from "@/lib/buyback/errors";
import { assertClearsFloor } from "@/lib/buyback/floor";
import { renderQuotationHtml } from "@/lib/buyback/pdf/quotation-template";
import { dealHeader, linesForRequest } from "@/lib/buyback/queries";
import { toVendorQuotation } from "@/lib/buyback/serialize";
import { BUYBACK_BUCKET, quotationKey } from "@/lib/buyback/storage";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";
import {
  currentLocks,
  listRoutableVendors,
  pickupLocation,
  quotationPhotoKeys,
} from "@/lib/buyback/vendors";
import { renderPdfFromHtml } from "@/lib/pdf/render-html";
import { putObject } from "@/lib/storage/s3";

export const runtime = "nodejs";
/** Puppeteer needs room; the default 10s would kill a 3-vendor render. */
export const maxDuration = 120;

const bodySchema = z.object({
  vendor_ids: z.array(z.string().uuid()).min(1),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);
    const body = bodySchema.parse(await req.json());

    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    // Fail fast before doing any expensive work. The authoritative check is
    // still the state machine inside the transaction below.
    if (header.status !== "MARGIN_SET") {
      throw new TransitionError(
        `The deal is ${header.status}. A lot can only be quoted out once the margin is locked.`,
      );
    }

    // --- What we are asking for ---------------------------------------------
    const locks = await currentLocks(header.deal_id);
    if (locks.length === 0) {
      throw new ValidationError("No locked prices on this deal — set the margin first.");
    }

    const missing = locks.filter((l) => l.vendor_ask === null);
    if (missing.length > 0) {
      throw new ValidationError(
        `${missing.length} line(s) have no ask price. The margin lock is incomplete — this is a data problem, not a user one.`,
      );
    }

    // M08: never quote below breakeven. The ask IS dealer_price + margin, so this
    // can only trip if the locks and floor_total disagree — but quoting a lot out
    // below the floor is the expensive mistake, so it is checked rather than
    // assumed.
    assertClearsFloor(
      locks.map((l) => ({
        line_id: l.line_id,
        quantity: Number(l.quantity),
        price: l.vendor_ask,
      })),
      header.floor_total,
    );

    // --- Who we are asking ---------------------------------------------------
    const routable = await listRoutableVendors();
    const byId = new Map(routable.map((v) => [v.id, v]));

    const vendors = body.vendor_ids.map((id) => {
      const vendor = byId.get(id);
      if (!vendor) {
        // Either the vendor does not exist, or their SCRAP_VENDOR role is not
        // ACTIVE — M18's AC: "unonboarded vendor unselectable for routing".
        throw new ValidationError(
          "One of the selected vendors is not onboarded and active, so it cannot be routed to.",
        );
      }
      if (!vendor.email) {
        throw new ValidationError(
          `${vendor.name} has no contact email, so the quotation cannot be sent.`,
        );
      }
      return vendor;
    });

    // --- Build the documents (outside the transaction) ------------------------
    const location = await pickupLocation(request.id);

    // ALL of them, ATTACHED — not two per line, base64-inlined into the PDF.
    //
    // The photos are the reason this email exists in the shape it does: a
    // recycler judges condition from them and should not have to log in to see
    // one. Inlining made that impossible on both ends — every byte was
    // duplicated into the document (base64 is ~33% overhead, and the PDF is
    // rendered once PER VENDOR), so the count had to be capped at 2/line and
    // rendered at 54x40px, a size at which a swollen cell and a healthy one look
    // the same. E-198 lets the event carry the keys, so the mailer attaches the
    // real files: full quality, all of them, fetched once at send.
    //
    // PER_LINE_CAP is not a byte budget, it is an attention budget: nobody opens
    // 60 attachments. The dealer uploads at least 5 per line (the submit gate),
    // and the display copy is the resized one — enough to judge a battery,
    // nothing like the original's size.
    const PER_LINE_CAP = 8;
    const photoKeys = await quotationPhotoKeys(request.id, PER_LINE_CAP);
    const attachmentKeys = Object.values(photoKeys).flat();

    // The E-191 battery spec, which currentLocks() does not carry — it selects
    // prices, not properties. Read from linesForRequest instead of widening
    // currentLocks: money stays lock-derived (invariant 2) and the spec comes
    // from the line, each from the query that owns it.
    const specs = new Map((await linesForRequest(request.id)).map((l) => [l.id, l]));

    const lineSources = locks.map((l) => {
      const spec = specs.get(l.line_id);

      // FIELD BY FIELD. Never `...spec`: AdminLineView carries dealer_price,
      // margin_value, vendor_ask AND vendor_price, and spreading it here would
      // hand the vendor our entire position in one line of convenience. The
      // serializer would drop them — VendorLineSource has no such fields — but
      // relying on that means the safety lives in a different file from the
      // mistake.
      return {
        line_id: l.line_id,
        quantity: Number(l.quantity),
        condition: l.condition,
        voltage: l.voltage,
        ah: l.ah,
        // ASK only. dealer_price is deliberately NOT passed — the vendor view has
        // no field for it, and this is the last place it could have leaked.
        ask_price: l.vendor_ask,
        variant_type: spec?.variant_type ?? null,
        brand: spec?.brand ?? null,
        chemistry: spec?.chemistry ?? null,
        form_factor: spec?.form_factor ?? null,
        nominal_voltage: spec?.nominal_voltage ?? null,
        nominal_ampere: spec?.nominal_ampere ?? null,
        unit_weight_kg: spec?.unit_weight_kg ?? null,
        warranty_cycles: spec?.warranty_cycles ?? null,
        functional_qty: spec?.functional_qty ?? null,
        non_functional_qty: spec?.non_functional_qty ?? null,
        iot_battery: spec?.iot_battery ?? null,
        iot_brand_name: spec?.iot_brand_name ?? null,
      };
    });

    const serial = request.request_no.replace(/^BB-/, "");

    const prepared = [];
    for (const [i, vendor] of vendors.entries()) {
      const threadId = randomUUID();
      const quotationNo = `QTN-${serial}-${i + 1}`;

      const quotation = toVendorQuotation({
        quotation_no: quotationNo,
        pickup_city: location.city,
        pickup_state: location.state,
        lines: lineSources,
      });

      // No photosByLine: the document is the itemised ask, the photos ride as
      // real attachments (E-198). Rendering them into the PDF meant re-encoding
      // every image into every vendor's copy.
      const pdf = await renderPdfFromHtml(
        renderQuotationHtml({
          quotation,
          vendorName: vendor.name,
          photoCount: attachmentKeys.length,
        }),
      );

      const key = quotationKey(request.id, threadId);
      await putObject(BUYBACK_BUCKET, key, pdf, "application/pdf");

      prepared.push({ threadId, quotationNo, vendor, key, askTotal: quotation.ask_total });
    }

    // --- Commit ---------------------------------------------------------------
    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      await tx.insert(vendorThreads).values(
        prepared.map((p) => ({
          id: p.threadId,
          deal_id: deal.id,
          vendor_id: p.vendor.id,
          status: "SENT" as const,
          quotation_no: p.quotationNo,
          quotation_pdf_s3: p.key,
        })),
      );

      // Itemized, always (P5). A vendor is asked per SKU and must answer per SKU.
      await tx.insert(vendorThreadLines).values(
        prepared.flatMap((p) =>
          locks.map((l) => ({
            thread_id: p.threadId,
            line_id: l.line_id,
            ask_price: String(l.vendor_ask),
          })),
        ),
      );

      return applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "route_to_vendors",
        actor: { id: actor.id, role: "admin" },
        after: {
          vendors: prepared.map((p) => ({ id: p.vendor.id, name: p.vendor.name })),
          ask_total: prepared[0]?.askTotal ?? null,
        },
        // ONE state change, N+1 messages: a portal ping for the admins, and one
        // quotation email per vendor — each with its own idempotency key, its own
        // recipient snapshotted, and its own PDF attached.
        fanOut: [
          {
            party: "ADMIN",
            channel: "PORTAL",
            discriminator: "portal",
            payload: {
              request_no: request.request_no,
              vendor_count: prepared.length,
            },
          },
          ...prepared.map((p) => ({
            party: "VENDOR" as const,
            channel: "EMAIL" as const,
            recipientRef: p.vendor.email,
            attachmentS3Key: p.key,
            // The battery photos, as real files. Snapshotted now, fetched at
            // send — and skipped individually if one has vanished, because a
            // missing photo must not cost the vendor the whole email.
            attachmentS3Keys: attachmentKeys,
            discriminator: p.threadId,
            payload: {
              thread_id: p.threadId,
              vendor_name: p.vendor.name,
              quotation_no: p.quotationNo,
              pickup_location: [location.city, location.state].filter(Boolean).join(", "),
              photo_count: attachmentKeys.length,
              // NOTE: no dealer identity, and no dealer_price. This payload is
              // rendered into the email body by the dispatcher.
            },
          })),
        ],
      });
    });

    return successResponse({
      request_id: request.id,
      status: outcome.to,
      threads: prepared.map((p) => ({
        thread_id: p.threadId,
        vendor_id: p.vendor.id,
        vendor_name: p.vendor.name,
        quotation_no: p.quotationNo,
      })),
    });
  },
);
