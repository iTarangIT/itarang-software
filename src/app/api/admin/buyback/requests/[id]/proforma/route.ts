/**
 * POST /api/admin/buyback/requests/:id/proforma   (E-196, BRD step 3)
 * GET  /api/admin/buyback/requests/:id/proforma
 *
 * iTarang raises the Proforma Invoice against the vendor's PO. This is the
 * document that was missing — the thing that ANSWERS the vendor's PO, between
 * PO_EXCHANGED and payment. Without it the sequence was incoherent: the vendor's
 * PO landed and nothing came back until a payment link.
 *
 * It is NOT the tax invoice. The existing INV-{n}-V stays exactly where it is
 * and becomes a real GST tax invoice the day the treatment is ruled on. A
 * proforma is our own statement of what we will charge; it draws on its own
 * PI-{n}-V series and carries no tax columns, because it must not imply a
 * treatment nobody has agreed to.
 *
 * THE AMOUNT IS SERVER-DERIVED (invariant 2). vendorReceipt(dealMoney) — Σ qty ×
 * vendor_price from the locks — never a figure from the client. A proforma the
 * vendor could influence the total of is not a proforma.
 *
 * REQUIRES A VENDOR PO. "Against that PO" is the whole point: no vendor PO, no
 * PI (404). And PO_EXCHANGED, because a PO cannot exist before it.
 *
 * RE-ISSUE SUPERSEDES. A partial unique index allows ONE live proforma per deal;
 * raising again marks the previous one SUPERSEDED in the same transaction rather
 * than leaving the vendor holding two current statements of what they owe. The
 * superseded row is kept — they may have paid against it.
 */

import { and, eq, sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { proformaInvoiceLines, proformaInvoices, purchaseOrders } from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { HttpError, NotFoundError } from "@/lib/buyback/errors";
import { dealMoney, vendorReceipt } from "@/lib/buyback/money";
import { loadAgreedVendorContact } from "@/lib/buyback/parties";
import { renderVendorInvoiceHtml } from "@/lib/buyback/pdf/vendor-invoice-template";
import { dealHeader } from "@/lib/buyback/queries";
import { BUYBACK_BUCKET } from "@/lib/buyback/storage";
import { renderPdfFromHtml } from "@/lib/pdf/render-html";
import { putObject } from "@/lib/storage/s3";

export const runtime = "nodejs";
export const maxDuration = 60;

/** BRD §6 — 72h, same window the quotation uses. */
const PROFORMA_VALIDITY_HOURS = 72;

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);
    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    const [live] = await db
      .select()
      .from(proformaInvoices)
      .where(and(eq(proformaInvoices.deal_id, header.deal_id), eq(proformaInvoices.status, "ISSUED")))
      .limit(1);

    return successResponse({ proforma: live ?? null });
  },
);

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);

    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    // A proforma answers a PO. Both POs must be exchanged first.
    if (header.status === "VENDOR_AGREED") {
      throw new HttpError(
        "The purchase orders have not been exchanged yet — a proforma answers the vendor's PO.",
        409,
      );
    }
    // PO_EXCHANGED onward is fine (the vendor might pay while the lot is in
    // pickup); only the states before it are refused.
    const beforePo = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "INFO_REQUESTED", "NEGOTIATING",
      "FINAL_OFFER_SENT", "DEALER_ACCEPTED", "MARGIN_SET", "VENDOR_ROUTED",
      "VENDOR_NEGOTIATING", "VENDOR_AGREED"];
    if (beforePo.includes(header.status)) {
      throw new HttpError(
        `The deal is ${header.status}. A proforma can only be raised once the purchase orders are exchanged.`,
        409,
      );
    }

    // The vendor's PO. No PO, no PI.
    const [vendorPo] = await db
      .select({ id: purchaseOrders.id, number: purchaseOrders.number })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.deal_id, header.deal_id), eq(purchaseOrders.leg, "VENDOR")))
      .limit(1);
    if (!vendorPo) {
      throw new NotFoundError("No vendor purchase order on this deal — nothing to raise a proforma against.");
    }

    // The amount, and the lines, from the locks. Server-derived.
    const money = await dealMoney(header.deal_id);
    const total = vendorReceipt(money);
    if (total === null) {
      throw new HttpError("The vendor price is not locked on every line — cannot raise a proforma.", 409);
    }

    const vendor = await loadAgreedVendorContact(header.deal_id);
    if (!vendor) {
      throw new HttpError("No agreed vendor on this deal.", 409);
    }

    const issuedOn = new Date();
    const validUntil = new Date(issuedOn.getTime() + PROFORMA_VALIDITY_HOURS * 3600 * 1000);

    // Mint the number off the PROFORMA series — never the tax-invoice series.
    const seq = await db.execute(sql`SELECT nextval('buyback_proforma_no_seq') AS n`);
    const number = `PI-${(seq as unknown as Array<{ n: string }>)[0].n}-V`;

    // Render BEFORE the transaction — a Puppeteer render must not hold a lock.
    const html = renderVendorInvoiceHtml({
      variant: "proforma",
      number,
      issued_on: issuedOn,
      valid_until: validUntil,
      their_po_number: vendorPo.number,
      buyer: { name: vendor.name, gstin: null, city: null, state: null },
      lines: money.map((m) => ({
        spec_label: m.spec_label,
        condition: m.condition_label,
        condition_key: m.condition,
        quantity: m.quantity,
        // The vendor's own agreed price. Never dealer_price, never margin.
        price_per_unit: m.vendor_price ?? 0,
      })),
      total,
    });
    const pdf = await renderPdfFromHtml(html);
    const pdfKey = `buyback/${request.id}/proforma/${number}.pdf`;
    await putObject(BUYBACK_BUCKET, pdfKey, pdf, "application/pdf");

    const created = await db.transaction(async (tx) => {
      // Supersede any live proforma first, so the partial unique index never
      // sees two ISSUED rows for one deal.
      await tx
        .update(proformaInvoices)
        .set({ status: "SUPERSEDED", updated_at: new Date() })
        .where(
          and(
            eq(proformaInvoices.deal_id, header.deal_id),
            eq(proformaInvoices.status, "ISSUED"),
          ),
        );

      const [pi] = await tx
        .insert(proformaInvoices)
        .values({
          deal_id: header.deal_id,
          po_id: vendorPo.id,
          number,
          pdf_s3: pdfKey,
          total: total.toString(),
          issued_at: issuedOn,
          valid_until: validUntil,
          created_by: actor.id,
        })
        .returning({ id: proformaInvoices.id });

      await tx.insert(proformaInvoiceLines).values(
        money.map((m) => ({
          proforma_id: pi.id,
          line_id: m.line_id,
          quantity: m.quantity,
          price_per_unit: (m.vendor_price ?? 0).toString(),
        })),
      );

      return pi;
    });

    return successResponse(
      { proforma_id: created.id, number, total, pdf_s3: pdfKey },
      201,
    );
  },
);
