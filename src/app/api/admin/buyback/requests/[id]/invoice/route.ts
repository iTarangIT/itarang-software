/**
 * GET  /api/admin/buyback/requests/:id/invoice — the invoice, with a per-line verdict
 * POST /api/admin/buyback/requests/:id/invoice — { action: "approve" | "return" }
 *
 * THE M12 ACCEPTANCE CRITERION LIVES HERE:
 *
 *     "one edited line blocks approval EVEN IF THE TOTAL MATCHES"
 *
 * A dealer who bills ₹5,500 on the working batteries and ₹2,700 on the dead ones —
 * when the locks say ₹5,200 and ₹3,000 — has produced an invoice whose TOTAL is
 * exactly right and whose every line is wrong. matchInvoiceToLocks() compares line
 * by line and refuses it; the approve action is not even reachable.
 *
 * The design prototype's `approveInv` sets the status to Approved and toasts
 * "Matched locked price ✓" WITHOUT COMPARING ANYTHING. That is the bug this route
 * exists to make impossible — so the comparison is recomputed here, server-side,
 * at the moment of approval. It is never trusted from the client, and never taken
 * from the `matched` flags a previous check may have written.
 *
 * ON APPROVAL we also raise iTarang's own invoice to the vendor, from the locked
 * vendor prices, on our own series — and email it. The two documents are created
 * in one transaction: a deal where we have accepted the dealer's bill but never
 * billed the vendor is a deal that leaks money.
 */

import { sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { invoiceLines, invoices } from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError, TransitionError, ValidationError } from "@/lib/buyback/errors";
import { matchInvoiceToLocks } from "@/lib/buyback/invoice-match";
import {
  dealMoney,
  invoicesForDeal,
  liveInvoice,
  settlementsForDeal,
  toLockedLines,
  vendorReceipt,
} from "@/lib/buyback/money";
import { renderVendorInvoiceHtml } from "@/lib/buyback/pdf/vendor-invoice-template";
import { dealHeader } from "@/lib/buyback/queries";
import { BUYBACK_BUCKET } from "@/lib/buyback/storage";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";
import { renderPdfFromHtml } from "@/lib/pdf/render-html";
import { putObject } from "@/lib/storage/s3";

export const runtime = "nodejs";
export const maxDuration = 60;

/** The agreed vendor, for the invoice we are about to send them. */
async function agreedVendor(dealId: string) {
  const rows = await db.execute(sql`
    SELECT a.business_entity_name AS name, a.gstin, a.city, a.state, a.contact_email AS email,
           (SELECT number FROM purchase_orders
             WHERE deal_id = ${dealId} AND leg = 'VENDOR' LIMIT 1) AS their_po
    FROM vendor_threads vt
    JOIN scrap_vendors sv ON sv.id = vt.vendor_id
    JOIN accounts a       ON a.id = sv.entity_id
    WHERE vt.deal_id = ${dealId} AND vt.status = 'AGREED'
    LIMIT 1
  `);
  return (rows as unknown as Array<Record<string, unknown>>)[0] ?? null;
}

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);

    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    const money = await dealMoney(header.deal_id);
    const all = await invoicesForDeal(header.deal_id);
    const live = all.find((i) => i.leg === "DEALER" && i.status !== "RETURNED");

    // The verdict, computed fresh. Never read back from the stored `matched`
    // flags — those are a record of a past check, not authority for this one.
    const match = live
      ? matchInvoiceToLocks(
          live.lines.map((l) => ({
            line_id: l.line_id,
            quantity: l.quantity,
            price_per_unit: l.price_per_unit,
          })),
          toLockedLines(money),
        )
      : null;

    return successResponse({
      request_id: request.id,
      status: header.status,
      invoice: live,
      match,
      history: all.filter((i) => i.status === "RETURNED"),
      vendor_invoice: all.find((i) => i.leg === "VENDOR") ?? null,
      // The settlement legs live here too, so the money pane fetches once.
      settlements: await settlementsForDeal(header.deal_id),
    });
  },
);

const bodySchema = z.object({
  action: z.enum(["approve", "return"]),
  reason: z.string().max(2000).optional(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);
    const body = bodySchema.parse(await req.json());

    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");
    if (header.status !== "INVOICE_RAISED") {
      throw new TransitionError(
        `The deal is ${header.status}. There is no invoice awaiting a decision.`,
      );
    }

    const money = await dealMoney(header.deal_id);
    const live = await liveInvoice(header.deal_id, "DEALER");
    if (!live) throw new NotFoundError("No invoice to act on.");

    const match = matchInvoiceToLocks(
      live.lines.map((l) => ({
        line_id: l.line_id,
        quantity: l.quantity,
        price_per_unit: l.price_per_unit,
      })),
      toLockedLines(money),
    );

    // ---------------------------------------------------------------- RETURN
    if (body.action === "return") {
      const reason = body.reason?.trim() || match.summary;
      if (!reason) {
        throw new ValidationError(
          "Say why the invoice is being returned — the dealer has to know what to correct.",
        );
      }

      const outcome = await db.transaction(async (tx) => {
        const deal = await loadDealForUpdate(tx, request.id);
        if (!deal) throw new NotFoundError("Deal not found.");

        // Record the verdict per line, so the failing line is still identifiable
        // months from now — not just the sentence we happened to write today.
        for (const v of match.verdicts) {
          await tx.execute(sql`
            UPDATE invoice_lines SET matched = ${v.matched}
            WHERE invoice_id = ${live.id} AND line_id = ${v.line_id}
          `);
        }

        await tx.execute(sql`
          UPDATE invoices
          SET status = 'RETURNED', returned_reason = ${reason}, returned_at = now(),
              updated_at = now()
          WHERE id = ${live.id}
        `);

        return applyTransition({
          tx,
          dealId: deal.id,
          requestId: request.id,
          currentStatus: deal.status,
          offerVersion: deal.offer_version,
          action: "return_invoice",
          actor: { id: actor.id, role: "admin" },
          after: { invoice_id: live.id, reason, mismatches: match.verdicts.filter((v) => !v.matched) },
          eventDiscriminator: live.id,
          notificationPayload: { request_no: request.request_no, reason },
        });
      });

      return successResponse({
        request_id: request.id,
        status: outcome.to,
        returned: true,
        reason,
      });
    }

    // --------------------------------------------------------------- APPROVE
    // THE GATE. Recomputed here, at the moment of approval — not trusted from the
    // client, not read back from a previous check's `matched` flags.
    if (!match.ok) {
      throw new ValidationError(
        `This invoice does not match what was agreed, so it cannot be approved. ${match.summary}`,
        {
          code: "INVOICE_MISMATCH",
          billed_total: match.billed_total,
          locked_total: match.locked_total,
          // The two totals are returned deliberately: when they are equal, the UI
          // must be able to say so, or an admin will think the check is broken.
          totals_agree: match.billed_total === match.locked_total,
          verdicts: match.verdicts,
        },
      );
    }

    const receipt = vendorReceipt(money);
    const vendor = await agreedVendor(header.deal_id);
    if (!vendor || receipt === null) {
      throw new ValidationError(
        "No agreed vendor price on this deal, so iTarang's invoice to the vendor cannot be raised.",
      );
    }

    // Our own series — the one invoice number we are entitled to issue.
    const seq = await db.execute(sql`SELECT nextval('buyback_invoice_no_seq') AS n`);
    const vendorInvoiceNo = `INV-${(seq as unknown as Array<{ n: string }>)[0].n}-V`;

    // Rendered before the transaction: Puppeteer must never hold a row lock.
    const pdf = await renderPdfFromHtml(
      renderVendorInvoiceHtml({
        number: vendorInvoiceNo,
        issued_on: new Date(),
        buyer: {
          name: String(vendor.name),
          gstin: (vendor.gstin as string) ?? null,
          city: (vendor.city as string) ?? null,
          state: (vendor.state as string) ?? null,
        },
        their_po_number: (vendor.their_po as string) ?? null,
        lines: money.map((m) => ({
          spec_label: m.spec_label,
          condition: m.condition_label,
          condition_key: m.condition,
          quantity: m.quantity,
          // The VENDOR price. Not the dealer's, not the margin.
          price_per_unit: m.vendor_price ?? 0,
        })),
        total: receipt,
      }),
    );

    const pdfKey = `buyback/${request.id}/invoices/${vendorInvoiceNo}.pdf`;
    await putObject(BUYBACK_BUCKET, pdfKey, pdf, "application/pdf");

    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      for (const v of match.verdicts) {
        await tx.execute(sql`
          UPDATE invoice_lines SET matched = TRUE
          WHERE invoice_id = ${live.id} AND line_id = ${v.line_id}
        `);
      }

      await tx.execute(sql`
        UPDATE invoices
        SET status = 'APPROVED', approved_by = ${actor.id}, approved_at = now(), updated_at = now()
        WHERE id = ${live.id}
      `);

      // iTarang's invoice to the vendor. Raised in the SAME transaction: a deal
      // where we have accepted the dealer's bill but never billed the vendor is a
      // deal that leaks money.
      const [vendorInvoice] = await tx
        .insert(invoices)
        .values({
          deal_id: deal.id,
          leg: "VENDOR",
          raised_by_party: "ITARANG",
          number: vendorInvoiceNo,
          pdf_s3: pdfKey,
          status: "RAISED",
          raised_by: actor.id,
        })
        .returning({ id: invoices.id });

      await tx.insert(invoiceLines).values(
        money.map((m) => ({
          invoice_id: vendorInvoice.id,
          line_id: m.line_id,
          quantity: m.quantity,
          price_per_unit: (m.vendor_price ?? 0).toString(),
        })),
      );

      return applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "approve_invoice",
        actor: { id: actor.id, role: "admin" },
        after: {
          invoice_id: live.id,
          vendor_invoice_id: vendorInvoice.id,
          vendor_invoice_no: vendorInvoiceNo,
          approved_total: match.billed_total,
        },
        eventDiscriminator: live.id,
        // The dealer hears their invoice is good. The vendor gets their bill.
        // The dealer's message must not mention the vendor invoice, and the
        // vendor's must not mention the dealer — hence two payloads, not one.
        fanOut: [
          {
            party: "DEALER",
            channel: "WHATSAPP",
            discriminator: `dealer:${live.id}`,
            payload: { request_no: request.request_no, number: live.number },
          },
          ...(vendor.email
            ? [
                {
                  party: "VENDOR" as const,
                  channel: "EMAIL" as const,
                  recipientRef: String(vendor.email),
                  attachmentS3Key: pdfKey,
                  discriminator: `vendor:${vendorInvoice.id}`,
                  payload: {
                    kind: "vendor_invoice",
                    vendor_name: String(vendor.name),
                    number: vendorInvoiceNo,
                    total: receipt,
                  },
                },
              ]
            : []),
        ],
      });
    });

    return successResponse({
      request_id: request.id,
      status: outcome.to,
      approved_total: match.billed_total,
      vendor_invoice_no: vendorInvoiceNo,
    });
  },
);
