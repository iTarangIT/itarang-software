/**
 * E-270 / E-271 — one refurbishment lot, from the NBFC's side.
 *
 *   GET   — the lot, its batteries (with custody), both legs, money, timeline
 *   POST  — the NBFC's moves:
 *             approve-quote (= accept) | counter | cancel | message
 *             pay-order | pay-verify | record-payment      (advance or balance)
 *             dispatch (nbfc_ships mode, with e-way bill)
 *             arrive (return leg) | confirm-receipt (return leg)
 *             approve-revision | reject-revision
 *
 * One `action` body rather than a dozen routes: they are one decision made in
 * one place, and a dozen files would be a dozen copies of the same ownership
 * check. NOTIFICATIONS FIRE HERE, NOT IN THE SERVICE.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError, validationError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  cancelLot,
  confirmReceipt,
  getLot,
  markArrived,
  postMessage,
  recordDispatch,
  respondToProposal,
  respondToRevision,
} from "@/lib/nbfc/recovery/refurbishment-lots";
import {
  confirmRefurbRazorpayPayment,
  createRefurbPaymentIntent,
  recordRefurbOfflinePayment,
} from "@/lib/nbfc/recovery/refurb-payments";
import { RECEIPT_CONDITIONS } from "@/lib/nbfc/recovery/refurbishment-lot-status";
import {
  notifyRefurbAgreed,
  notifyRefurbArrived,
  notifyRefurbCancelled,
  notifyRefurbCountered,
  notifyRefurbDispatched,
  notifyRefurbMessage,
  notifyRefurbPaymentConfirmed,
  notifyRefurbPaymentRecorded,
  notifyRefurbReceived,
  notifyRefurbRevisionAnswered,
} from "@/lib/nbfc/recovery/refurbish-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const ActionBody = z
  .object({
    action: z.enum([
      "accept",
      "approve-quote",
      "counter",
      "cancel",
      "dispatch",
      "arrive",
      "confirm-receipt",
      "message",
      "pay-order",
      "pay-verify",
      "record-payment",
      "approve-revision",
      "reject-revision",
    ]),
    message: z.string().trim().max(2000).optional(),
    // counter
    requested_receipt_date: DateStr.nullable().optional(),
    requested_return_date: DateStr.nullable().optional(),
    // dispatch
    carrier: z.string().trim().max(120).nullable().optional(),
    vehicle_no: z.string().trim().max(32).nullable().optional(),
    docket_no: z.string().trim().max(64).nullable().optional(),
    eway_bill_no: z.string().trim().max(32).nullable().optional(),
    eway_bill_url: z.string().max(500).nullable().optional(),
    dispatched_on: DateStr.optional(),
    photo_urls: z.array(z.string().max(500)).max(20).optional(),
    // confirm-receipt
    items: z
      .array(
        z.object({
          job_id: z.string().uuid(),
          condition: z.enum(RECEIPT_CONDITIONS),
          note: z.string().trim().max(1000).nullable().optional(),
          photo_urls: z.array(z.string().max(500)).max(10).optional(),
        }),
      )
      .max(100)
      .optional(),
    // money
    leg: z.enum(["advance", "balance"]).optional(),
    reference: z.string().trim().min(3).max(120).optional(),
    razorpay_order_id: z.string().min(3).max(64).optional(),
    razorpay_payment_id: z.string().min(3).max(64).optional(),
    razorpay_signature: z.string().min(3).max(200).optional(),
  })
  .strict();

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;
    const lot = await getLot(id, actor.tenant_id);
    if (!lot) return NextResponse.json({ ok: false, error: "NOT_FOUND: lot not found" }, { status: 404 });
    return NextResponse.json({ ok: true, lot });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = ActionBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: validationError(parsed.error), issues: parsed.error.issues }, { status: 400 });
    }
    const b = parsed.data;
    const base = { lot_id: id, tenant_id: actor.tenant_id, actor_user_id: actor.user_id ?? null };
    const bad = (m: string) => NextResponse.json({ ok: false, error: `BAD_REQUEST: ${m}` }, { status: 400 });

    switch (b.action) {
      case "accept":
      case "approve-quote": {
        const lot = await respondToProposal({ ...base, kind: "accept", message: b.message ?? null });
        await notifyRefurbAgreed(lot);
        return NextResponse.json({ ok: true, lot });
      }
      case "counter": {
        const lot = await respondToProposal({ ...base, kind: "counter", message: b.message ?? null, requested_receipt_date: b.requested_receipt_date ?? null, requested_return_date: b.requested_return_date ?? null });
        await notifyRefurbCountered(lot, b.message ?? null);
        return NextResponse.json({ ok: true, lot });
      }
      case "cancel": {
        const lot = await cancelLot({ ...base, party: "nbfc", reason: b.message ?? null });
        await notifyRefurbCancelled(lot, "nbfc", b.message ?? null);
        return NextResponse.json({ ok: true, lot });
      }
      case "dispatch": {
        if (!b.dispatched_on) return bad("dispatched_on is required");
        const lot = await recordDispatch({
          ...base,
          leg: "out",
          carrier: b.carrier ?? null,
          vehicle_no: b.vehicle_no ?? null,
          docket_no: b.docket_no ?? null,
          eway_bill_no: b.eway_bill_no ?? null,
          eway_bill_url: b.eway_bill_url ?? null,
          dispatched_on: b.dispatched_on,
          note: b.message ?? null,
          photo_urls: b.photo_urls ?? [],
        });
        await notifyRefurbDispatched(lot, "out", "dispatched");
        return NextResponse.json({ ok: true, lot });
      }
      case "arrive": {
        const lot = await markArrived({ ...base, leg: "return", note: b.message ?? null });
        await notifyRefurbArrived(lot, "return");
        return NextResponse.json({ ok: true, lot });
      }
      case "confirm-receipt": {
        if (!b.items?.length) return bad("items are required");
        const lot = await confirmReceipt({ ...base, leg: "return", items: b.items, note: b.message ?? null, photo_urls: b.photo_urls ?? [] });
        const tally = { received: 0, damaged: 0, missing: 0 };
        for (const it of b.items) tally[it.condition]++;
        await notifyRefurbReceived(lot, "return", tally);
        return NextResponse.json({ ok: true, lot });
      }
      case "pay-order": {
        if (!b.leg) return bad("leg is required");
        const intent = await createRefurbPaymentIntent({ lot_id: id, tenant_id: actor.tenant_id, leg: b.leg });
        return NextResponse.json({ ok: true, intent });
      }
      case "pay-verify": {
        if (!b.leg || !b.razorpay_order_id || !b.razorpay_payment_id || !b.razorpay_signature) return bad("leg + razorpay_order_id + razorpay_payment_id + razorpay_signature are required");
        const lot = await confirmRefurbRazorpayPayment({ ...base, leg: b.leg, razorpay_order_id: b.razorpay_order_id, razorpay_payment_id: b.razorpay_payment_id, razorpay_signature: b.razorpay_signature });
        await notifyRefurbPaymentConfirmed(lot, b.leg);
        return NextResponse.json({ ok: true, lot });
      }
      case "record-payment": {
        if (!b.leg || !b.reference) return bad("leg + reference are required");
        const lot = await recordRefurbOfflinePayment({ ...base, leg: b.leg, reference: b.reference, note: b.message ?? null });
        await notifyRefurbPaymentRecorded(lot, b.leg);
        return NextResponse.json({ ok: true, lot });
      }
      case "approve-revision":
      case "reject-revision": {
        const kind = b.action === "approve-revision" ? "approve" : "reject";
        const lot = await respondToRevision({ ...base, kind, message: b.message ?? null });
        await notifyRefurbRevisionAnswered(lot, kind, b.message ?? null);
        return NextResponse.json({ ok: true, lot });
      }
      case "message": {
        if (!b.message?.trim()) return bad("message is required");
        const lot = await postMessage({ ...base, party: "nbfc", message: b.message });
        await notifyRefurbMessage(lot, "nbfc", b.message);
        return NextResponse.json({ ok: true, lot });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}
