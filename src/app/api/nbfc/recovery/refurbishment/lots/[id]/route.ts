/**
 * E-292 — one refurbishment lot, from the NBFC's side (refurbish flow v3).
 *
 *   GET   — the lot, its batteries (with custody), the PI, both legs, money,
 *           timeline. REDACTED: the NBFC never sees the refurbisher.
 *   POST  — the NBFC's moves:
 *             accept | counter (cost / advance % / dates / message) | cancel
 *             accept-pi | record-payment (advance or balance — a UTR)
 *             dispatch (nbfc_ships mode; e-way bill optional)
 *             arrive (return leg) | confirm-receipt (return leg)
 *             close (redeploy | auction) | message
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
  acceptPi,
  cancelLot,
  closeLot,
  confirmReceipt,
  getLot,
  markArrived,
  postMessage,
  recordDispatch,
  respondToEstimate,
} from "@/lib/nbfc/recovery/refurbishment-lots";
import { recordRefurbOfflinePayment } from "@/lib/nbfc/recovery/refurb-payments";
import { CLOSE_OUTCOMES, RECEIPT_CONDITIONS } from "@/lib/nbfc/recovery/refurbishment-lot-status";
import {
  notifyRefurbAgreed,
  notifyRefurbArrived,
  notifyRefurbCancelled,
  notifyRefurbClosed,
  notifyRefurbCountered,
  notifyRefurbDispatched,
  notifyRefurbMessage,
  notifyRefurbPaymentRecorded,
  notifyRefurbPiAccepted,
  notifyRefurbReceived,
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
      "counter",
      "cancel",
      "accept-pi",
      "record-payment",
      "dispatch",
      "arrive",
      "confirm-receipt",
      "close",
      "message",
    ]),
    message: z.string().trim().max(2000).optional(),
    // counter
    counter_total: z.number().min(0).max(100_000_000).nullable().optional(),
    counter_advance_pct: z.number().min(0).max(100).nullable().optional(),
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
    // close
    outcome: z.enum(CLOSE_OUTCOMES as [string, ...string[]]).optional(),
  })
  .strict();

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;
    const lot = await getLot(id, { tenant_id: actor.tenant_id }, "nbfc");
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
    const scope = { tenant_id: actor.tenant_id };
    const base = { lot_id: id, tenant_id: actor.tenant_id, actor_user_id: actor.user_id ?? null };
    const bad = (m: string) => NextResponse.json({ ok: false, error: `BAD_REQUEST: ${m}` }, { status: 400 });

    switch (b.action) {
      case "accept": {
        const lot = await respondToEstimate({ ...base, kind: "accept", message: b.message ?? null });
        await notifyRefurbAgreed(lot);
        return NextResponse.json({ ok: true, lot });
      }
      case "counter": {
        const lot = await respondToEstimate({
          ...base,
          kind: "counter",
          message: b.message ?? null,
          counter_total: b.counter_total ?? null,
          counter_advance_pct: b.counter_advance_pct ?? null,
          requested_receipt_date: b.requested_receipt_date ?? null,
          requested_return_date: b.requested_return_date ?? null,
        });
        await notifyRefurbCountered(lot, b.message ?? null);
        return NextResponse.json({ ok: true, lot });
      }
      case "cancel": {
        const lot = await cancelLot({ ...base, party: "nbfc", reason: b.message ?? null });
        await notifyRefurbCancelled(lot, "nbfc", b.message ?? null);
        return NextResponse.json({ ok: true, lot });
      }
      case "accept-pi": {
        const lot = await acceptPi({ ...base, note: b.message ?? null });
        await notifyRefurbPiAccepted(lot);
        return NextResponse.json({ ok: true, lot });
      }
      case "record-payment": {
        if (!b.leg || !b.reference) return bad("leg + reference are required");
        const lot = await recordRefurbOfflinePayment({ ...base, leg: b.leg, reference: b.reference, note: b.message ?? null });
        await notifyRefurbPaymentRecorded(lot, b.leg);
        return NextResponse.json({ ok: true, lot });
      }
      case "dispatch": {
        if (!b.dispatched_on) return bad("dispatched_on is required");
        const lot = await recordDispatch({
          lot_id: id,
          scope,
          actor_user_id: actor.user_id ?? null,
          leg: "out",
          party: "nbfc",
          carrier: b.carrier ?? null,
          vehicle_no: b.vehicle_no ?? null,
          docket_no: b.docket_no ?? null,
          eway_bill_no: b.eway_bill_no ?? null,
          eway_bill_url: b.eway_bill_url ?? null,
          dispatched_on: b.dispatched_on,
          note: b.message ?? null,
          photo_urls: b.photo_urls ?? [],
        });
        await notifyRefurbDispatched(lot, "out", "dispatched", "nbfc");
        return NextResponse.json({ ok: true, lot });
      }
      case "arrive": {
        const lot = await markArrived({ lot_id: id, scope, actor_user_id: actor.user_id ?? null, leg: "return", note: b.message ?? null });
        await notifyRefurbArrived(lot, "return");
        return NextResponse.json({ ok: true, lot });
      }
      case "confirm-receipt": {
        if (!b.items?.length) return bad("items are required");
        const lot = await confirmReceipt({ lot_id: id, scope, actor_user_id: actor.user_id ?? null, leg: "return", items: b.items, note: b.message ?? null, photo_urls: b.photo_urls ?? [] });
        const tally = { received: 0, damaged: 0, missing: 0 };
        for (const it of b.items) tally[it.condition]++;
        await notifyRefurbReceived(lot, "return", tally);
        return NextResponse.json({ ok: true, lot });
      }
      case "close": {
        if (!b.outcome) return bad("outcome (redeploy | auction) is required");
        const lot = await closeLot({ ...base, outcome: b.outcome as "redeploy" | "auction", note: b.message ?? null });
        await notifyRefurbClosed(lot);
        return NextResponse.json({ ok: true, lot, next: b.outcome === "auction" ? "/nbfc/auction/compose" : null });
      }
      case "message": {
        if (!b.message?.trim()) return bad("message is required");
        const lot = await postMessage({ lot_id: id, scope, actor_user_id: actor.user_id ?? null, party: "nbfc", message: b.message });
        await notifyRefurbMessage(lot, "nbfc", b.message);
        return NextResponse.json({ ok: true, lot });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}
