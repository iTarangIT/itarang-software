/**
 * POST /api/payments/razorpay/payout-webhook   (E-193/R4)
 *
 * RazorpayX webhook for buyback dealer payouts — the signature-verified SOURCE OF
 * TRUTH for a payout's terminal state. The initiation route mints the attempt and
 * kicks the payout; the poller is the backstop; THIS is the fast path that records
 * PROCESSED (→ a settlement) / FAILED / REVERSED the moment RazorpayX fires it.
 *
 * Mirrors the emandate-webhook discipline: nodejs runtime, force-dynamic, raw
 * body, HMAC-SHA256 signature on x-razorpay-signature, and ALWAYS 200 once the
 * signature passes (even for events we ignore) so RazorpayX does not retry-storm.
 *
 * DARK UNLESS CONFIGURED: with RAZORPAYX_WEBHOOK_SECRET unset the endpoint 200-
 * ignores every call before touching the DB — a webhook must never 500 on missing
 * config. The mapping is NOT reimplemented here: mapPayoutStatus (lib/buyback/
 * gateway.ts) is the one place a provider status becomes an outcome.
 *
 * Register in the RazorpayX Dashboard → Webhooks for:
 *   payout.pending, payout.queued, payout.initiated, payout.processed,
 *   payout.updated, payout.reversed, payout.failed, payout.rejected.
 */

import { NextRequest, NextResponse } from "next/server";

import {
  adoptGatewayProviderRef,
  applyGatewayOutcome,
  findGatewayTxnByProviderRef,
  getGatewayTxn,
  mapPayoutStatus,
} from "@/lib/buyback/gateway";
import { verifyWebhookSignature } from "@/lib/razorpay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const asStr = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const asNum = (v: unknown): number =>
  typeof v === "number" ? v : Number(v) || 0;

let warnedMissingSecret = false;

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();

    const secret = process.env.RAZORPAYX_WEBHOOK_SECRET;
    if (!secret) {
      if (!warnedMissingSecret) {
        console.debug("[RZPX payout webhook] RAZORPAYX_WEBHOOK_SECRET unset — ignoring");
        warnedMissingSecret = true;
      }
      return NextResponse.json({ ignored: true });
    }

    const signature = req.headers.get("x-razorpay-signature");
    if (!signature) {
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }
    try {
      if (!verifyWebhookSignature(body, signature, secret)) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    } catch {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // --- Signature has passed. From here every path returns 200. ---
    const event = JSON.parse(body) as Json;
    const entity = asObj(asObj(asObj(event.payload).payout).entity);
    const entityId = asStr(entity.id);
    const notes = asObj(entity.notes);

    // Scope: only OUR dealer payouts. Anything else on this endpoint is ignored.
    if (asStr(notes.itarang_purpose) !== "buyback_dealer_payout") {
      return NextResponse.json({ ignored: true, reason: "not a buyback dealer payout" });
    }

    // Correlate: by the provider id first, then fall back to the gateway txn id we
    // stamped into notes (and adopt the provider id onto it).
    let row = entityId ? await findGatewayTxnByProviderRef(entityId) : null;
    if (!row) {
      const fallbackId = asStr(notes.itarang_gateway_txn_id);
      if (fallbackId) {
        row = await getGatewayTxn(fallbackId);
        if (row && !row.provider_ref && entityId) {
          await adoptGatewayProviderRef(row.id, entityId);
        }
      }
    }
    if (!row) {
      console.warn(
        "[RZPX payout webhook] no gateway txn for payout",
        entityId,
        asStr(notes.itarang_gateway_txn_id),
      );
      return NextResponse.json({ ignored: true, reason: "no matching attempt" });
    }

    // The payout entity carries its own canonical status (falling back to the
    // event-name suffix). mapPayoutStatus turns an unknown status into null → skip.
    const status =
      asStr(entity.status) ?? (asStr(event.event) ?? "").split(".")[1] ?? "";
    const outcome = mapPayoutStatus(status, {
      utr: asStr(entity.utr),
      amountPaise: asNum(entity.amount),
      failureReason: asStr(entity.failure_reason),
      raw: entity,
    });
    if (!outcome) {
      return NextResponse.json({ ignored: true, reason: `unhandled status ${status}` });
    }

    const result = await applyGatewayOutcome(row.id, outcome);
    return NextResponse.json({ ok: true, applied: result.applied });
  } catch (error) {
    console.error("[RZPX payout webhook] Error:", error);
    // 200 so RazorpayX does not retry forever; the error is logged.
    return NextResponse.json({ status: "error_logged" }, { status: 200 });
  }
}
