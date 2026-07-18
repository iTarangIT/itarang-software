/**
 * Recording the VENDOR's purchase order (M11 / E-196) — one implementation,
 * two callers:
 *
 *   · an admin RECORDING a PO a vendor emailed
 *       (POST /api/admin/buyback/requests/:id/po/vendor)
 *   · the vendor raising their OWN PO from their dashboard (E-196)
 *       (POST /api/vendor/threads/:id/po)
 *
 * On the vendor leg the vendor is the BUYER, and the buyer initiates the PO. So
 * both paths write the same row — direction RECEIVED, status ACKNOWLEDGED, the
 * vendor's own number and PDF — and complete the same pair. What differs is only
 * WHO acted, which decides the audit action, exactly as vendor-response.ts does
 * for counter/agree.
 *
 * WHY THIS IS A LIB. The pair-completeness check and the branch between
 * recordActivity (one leg down) and applyTransition('exchange_pos') (pair
 * complete) are the load-bearing part. exchange_pos fires INSIDE whichever
 * transaction completes the pair and moves the deal exactly once; a second copy
 * of that logic is a second chance to fire it twice, or not at all. The dealer
 * PO is generated from the locks and is admin-only, so it stays in its route;
 * only the vendor-leg write is shared.
 *
 * The DEALER's activity filter now keys on the ACTION, not the role
 * (serialize.ts), precisely because exchange_pos here can carry role='vendor' or
 * role='admin' by pure upload order — the dealer must see their PO exchange
 * either way.
 */

import { eq } from "drizzle-orm";

import { purchaseOrders } from "@/lib/db/schema";
import { applyTransition, loadDealForUpdate, recordActivity } from "./transition";
import type { BuybackTx } from "./tx";

export interface RecordVendorPoInput {
  tx: BuybackTx;
  requestId: string;
  /** The vendor's own PO number — their series, not ours. */
  number: string;
  /** S3 key of the vendor's uploaded PO PDF, if they attached one. */
  pdfS3?: string | null;
  /** Who is recording it. 'vendor' = first-hand; 'admin' = transcribing an email. */
  actor: { id: string | null; role: "admin" | "vendor" };
  requestNo: string;
}

export interface RecordVendorPoOutcome {
  status: string;
  po_id: string;
  number: string;
  /** True when this PO completed the pair and moved the deal to PO_EXCHANGED. */
  exchanged: boolean;
}

/**
 * Record the vendor's PO inside an open transaction, moving the deal to
 * PO_EXCHANGED iff this completes the pair.
 *
 * Caller is responsible for authorisation and for having confirmed the deal is
 * VENDOR_AGREED — an admin route proves staff, a vendor route proves the thread
 * is theirs. This trusts the ids it is given.
 */
export async function recordVendorPo({
  tx,
  requestId,
  number,
  pdfS3,
  actor,
  requestNo,
}: RecordVendorPoInput): Promise<RecordVendorPoOutcome> {
  const deal = await loadDealForUpdate(tx, requestId);
  if (!deal) throw new Error("Deal not found.");

  const [po] = await tx
    .insert(purchaseOrders)
    .values({
      deal_id: deal.id,
      leg: "VENDOR",
      // The vendor issues it TO us — we receive it. Same on both paths: a vendor
      // raising it and an admin recording it describe the same physical event.
      direction: "RECEIVED",
      number,
      pdf_s3: pdfS3 ?? null,
      status: "ACKNOWLEDGED",
      counterparty_entity_id: null,
      issued_at: new Date(),
      acknowledged_at: new Date(),
      created_by: actor.id,
    })
    .returning({ id: purchaseOrders.id });

  // No purchase_order_lines for the vendor leg: we did not price it, they did,
  // and their PDF is the record. (The dealer PO copies its lines from the locks
  // because WE generated it.)

  const both = await tx
    .select({ leg: purchaseOrders.leg })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.deal_id, deal.id));

  const legs = new Set(both.map((r) => r.leg));
  const complete = legs.has("DEALER") && legs.has("VENDOR");

  if (!complete) {
    // One leg down. A real change, so it is audited — but the deal has not
    // moved, so no transition and no notification. The action names who did it:
    // record_vendor_po (admin, hearsay) vs submit_vendor_po (vendor, first-hand).
    await recordActivity({
      tx,
      requestId,
      dealId: deal.id,
      actor,
      action: actor.role === "vendor" ? "submit_vendor_po" : "record_vendor_po",
      after: { po_id: po.id, leg: "VENDOR", number },
    });

    return { status: deal.status, po_id: po.id, number, exchanged: false };
  }

  // The pair is complete — the deal moves, exactly once. applyTransition's
  // status write is guarded on the status we read, so a race that completes the
  // pair twice finds the deal already PO_EXCHANGED and the second one 409s.
  const result = await applyTransition({
    tx,
    dealId: deal.id,
    requestId,
    currentStatus: deal.status,
    offerVersion: deal.offer_version,
    action: "exchange_pos",
    actor,
    after: { po_id: po.id, leg: "VENDOR", number, both_legs: true },
    notificationPayload: { request_no: requestNo, po_number: number },
  });

  return { status: result.to, po_id: po.id, number, exchanged: true };
}
