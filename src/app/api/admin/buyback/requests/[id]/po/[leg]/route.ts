/**
 * POST /api/admin/buyback/requests/:id/po/:leg      (BRD M11 / U7)
 *
 *   leg=dealer — iTarang ISSUES a PO to the dealer. Generated from
 *                deal_line_locks, rendered to a PDF, stored.
 *   leg=vendor — the vendor ISSUES a PO to iTarang; an admin RECORDS it
 *                (number + their PDF).
 *
 * "Buyer initiates" (U7) is why the direction is not derivable from the leg by
 * some clever rule and is stored explicitly: iTarang is the BUYER from the
 * dealer, and the SELLER to the vendor. Each side's buyer raises the PO.
 *
 * AC: "PO impossible before VENDOR_AGREED." Enforced twice — a fail-fast check
 * here, and the state machine, which has no `exchange_pos` edge out of any
 * earlier state.
 *
 * PO_EXCHANGED fires automatically inside the transaction that records whichever
 * PO completes the pair. It cannot fire twice: applyTransition's status write is
 * guarded on the status we read (`WHERE id = ? AND status = 'VENDOR_AGREED'`), so
 * a duplicate request finds the deal already PO_EXCHANGED and 409s.
 *
 * The dealer's PO prices are COPIED onto purchase_order_lines, not joined to the
 * locks. A PO that has gone out is a document with a life of its own; a later
 * lock generation must not silently restate what a counterparty already holds on
 * paper.
 */

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { purchaseOrderLines, purchaseOrders } from "@/lib/db/schema";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError, TransitionError, ValidationError } from "@/lib/buyback/errors";
import { formatBatteryLine } from "@/lib/buyback/format";
import { renderDealerPoHtml } from "@/lib/buyback/pdf/po-template";
import { dealHeader } from "@/lib/buyback/queries";
import { BUYBACK_BUCKET, poKey } from "@/lib/buyback/storage";
import { applyTransition, loadDealForUpdate } from "@/lib/buyback/transition";
import { currentLocks } from "@/lib/buyback/vendors";
import { renderPdfFromHtml } from "@/lib/pdf/render-html";
import { putObject } from "@/lib/storage/s3";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  /** The vendor's own PO number. Required on the vendor leg; ignored on the dealer leg. */
  number: z.string().min(1).max(64).optional(),
  /** An already-uploaded S3 key for the vendor's PO PDF (via the presign route). */
  pdf_s3: z.string().min(1).optional(),
});

/** The dealer's billing identity — for the PO we address to them. */
async function dealerParty(requestId: string) {
  const rows = await db.execute(sql`
    SELECT a.business_entity_name AS name, a.gstin, a.city, a.state,
           bpa.label AS pickup_label, bpa.address_line1, bpa.city AS pickup_city,
           bpa.state AS pickup_state, bpa.pincode
    FROM buyback_requests br
    JOIN accounts a ON a.id = br.dealer_entity_id
    LEFT JOIN buyback_batches bb ON bb.request_id = br.id
    LEFT JOIN buyback_pickup_addresses bpa ON bpa.id = bb.pickup_address_id
    WHERE br.id = ${requestId}
    LIMIT 1
  `);
  return (rows as unknown as Array<Record<string, unknown>>)[0] ?? null;
}

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string; leg: string }> }) => {
    const { id: requestId, leg: legParam } = await ctx.params;
    const actor = await requireBuybackAdmin();

    const leg = legParam.toUpperCase();
    if (leg !== "DEALER" && leg !== "VENDOR") {
      throw new ValidationError(`Unknown PO leg "${legParam}". Expected "dealer" or "vendor".`);
    }

    const request = await loadAnyRequest(requestId);
    const body = bodySchema.parse(await req.json().catch(() => ({})));

    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    // M11 AC — fail fast, before generating anything.
    if (header.status !== "VENDOR_AGREED") {
      throw new TransitionError(
        header.status === "PO_EXCHANGED"
          ? "Both purchase orders are already exchanged on this deal."
          : `The deal is ${header.status}. A purchase order is impossible before a vendor has agreed.`,
      );
    }

    // ---------------------------------------------------------- prepare the doc
    let number: string;
    let pdfKey: string | null = null;
    let lines: Array<{ line_id: string; quantity: number; price_per_unit: string }> = [];

    if (leg === "VENDOR") {
      // The vendor is the buyer here — they raise the PO, we record it. This is
      // the ONE place the admin and vendor paths converge: an admin recording an
      // emailed PO and the vendor uploading their own describe the same event,
      // so both go through recordVendorPo (E-196). Nothing to render — the
      // vendor's number is the record and their PDF is the evidence.
      if (!body.number) {
        throw new ValidationError("The vendor's purchase order number is required.");
      }

      const outcome = await db.transaction((tx) =>
        recordVendorPo({
          tx,
          requestId: request.id,
          number: body.number!,
          pdfS3: body.pdf_s3,
          // 'admin' — recorded on the vendor's behalf, which the audit action
          // (record_vendor_po) reflects.
          actor: { id: actor.id, role: "admin" },
          requestNo: request.request_no,
        }),
      );

      return successResponse({
        request_id: request.id,
        leg,
        po_id: outcome.po_id,
        number: outcome.number,
        status: outcome.status,
        exchanged: outcome.exchanged,
      });
    } else {
      // We are the buyer. Generate the PO from the locks.
      const locks = await currentLocks(header.deal_id);
      if (locks.length === 0) {
        throw new ValidationError("No locked prices on this deal — nothing to raise a PO for.");
      }

      const seq = await db.execute(sql`SELECT nextval('buyback_po_no_seq') AS n`);
      const n = (seq as unknown as Array<{ n: string }>)[0].n;
      number = `PO-${n}-D`;

      lines = locks.map((l) => ({
        line_id: l.line_id,
        quantity: Number(l.quantity),
        // The DEALER's locked price. Not the ask, not the vendor price — this
        // document tells the dealer what iTarang owes them.
        price_per_unit: l.dealer_price,
      }));

      const party = await dealerParty(request.id);
      const total = lines.reduce((s, l) => s + l.quantity * Number(l.price_per_unit), 0);

      const address = party
        ? [party.address_line1, party.pickup_city, party.pickup_state, party.pincode]
            .filter(Boolean)
            .join(", ")
        : null;

      const html = renderDealerPoHtml({
        number,
        issued_on: new Date(),
        request_no: request.request_no,
        supplier: {
          name: String(party?.name ?? "Dealer"),
          gstin: (party?.gstin as string) ?? null,
          city: (party?.city as string) ?? null,
          state: (party?.state as string) ?? null,
        },
        lines: locks.map((l) => {
          const f = formatBatteryLine({
            id: l.line_id,
            quantity: Number(l.quantity),
            condition: l.condition,
            voltage: l.voltage,
            ah: l.ah,
          });
          return {
            spec_label: f.specLabel,
            condition: f.condition,
            condition_key: f.conditionKey,
            quantity: Number(l.quantity),
            price_per_unit: l.dealer_price,
          };
        }),
        total,
        pickup_address: address,
      });

      // Rendered and uploaded BEFORE the transaction, for the same reason as the
      // quotation: a Puppeteer render must not hold a row lock.
      const pdf = await renderPdfFromHtml(html);
      pdfKey = poKey(request.id, "DEALER", number);
      await putObject(BUYBACK_BUCKET, pdfKey, pdf, "application/pdf");
    }

    // ------------------------------------------------------------------ commit
    // Only the DEALER leg reaches here — the VENDOR leg returned above via
    // recordVendorPo. We are the buyer, so this PO is ISSUED and SENT, with its
    // lines copied from the locks.
    const outcome = await db.transaction(async (tx) => {
      const deal = await loadDealForUpdate(tx, request.id);
      if (!deal) throw new NotFoundError("Deal not found.");

      const [po] = await tx
        .insert(purchaseOrders)
        .values({
          deal_id: deal.id,
          leg: "DEALER",
          direction: "ISSUED",
          number,
          pdf_s3: pdfKey,
          status: "SENT",
          counterparty_entity_id: request.dealer_entity_id,
          issued_at: new Date(),
          created_by: actor.id,
        })
        .returning({ id: purchaseOrders.id });

      await tx.insert(purchaseOrderLines).values(
        lines.map((l) => ({
          po_id: po.id,
          line_id: l.line_id,
          quantity: l.quantity,
          price_per_unit: l.price_per_unit,
          // Tax columns stay NULL. GST/HSN/reverse-charge is Chirag's open item
          // (BRD §10); the document says "tax treatment pending" rather than
          // implying a treatment nobody has agreed to.
        })),
      );

      // Does the vendor PO already exist? If so, the dealer PO completes the pair.
      const both = await tx
        .select({ leg: purchaseOrders.leg })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.deal_id, deal.id));

      const legs = new Set(both.map((r) => r.leg));
      const complete = legs.has("DEALER") && legs.has("VENDOR");

      if (!complete) {
        // The vendor PO is not in yet. Audited, but the deal has not moved.
        const { recordActivity } = await import("@/lib/buyback/transition");
        await recordActivity({
          tx,
          requestId: request.id,
          dealId: deal.id,
          actor: { id: actor.id, role: "admin" },
          action: "issue_dealer_po",
          after: { po_id: po.id, leg: "DEALER", number },
        });

        return { status: deal.status, po_id: po.id, number, exchanged: false };
      }

      // The pair is complete — the deal moves, exactly once.
      const result = await applyTransition({
        tx,
        dealId: deal.id,
        requestId: request.id,
        currentStatus: deal.status,
        offerVersion: deal.offer_version,
        action: "exchange_pos",
        actor: { id: actor.id, role: "admin" },
        after: { po_id: po.id, leg: "DEALER", number, both_legs: true },
        notificationPayload: { request_no: request.request_no, po_number: number },
      });

      return { status: result.to, po_id: po.id, number, exchanged: true };
    });

    return successResponse({
      request_id: request.id,
      leg,
      po_id: outcome.po_id,
      number: outcome.number,
      status: outcome.status,
      pos_exchanged: outcome.exchanged,
    });
  },
);
