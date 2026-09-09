/**
 * E-292 — one refurbishment lot, from iTarang's side (refurbish flow v3).
 *
 *   GET   — the lot, its batteries (with custody), the PI, both legs, money,
 *           the refurbisher, timeline (+ can_act). Unredacted.
 *   POST  — the desk's moves:
 *             review (decline per battery; empty = "mark reviewed") | estimate |
 *             cancel | send-pi | confirm-payment (advance or balance) |
 *             pickup (itarang_pickup mode) | arrive (out) | confirm-receipt (out) |
 *             assign (refurbisher) | start-work · update-item · cost-item (admin
 *             override of the refurbisher's moves) | set-final-cost | mark-ready |
 *             dispatch (return) | message (to nbfc | refurbisher)
 *
 * WHO MAY ACT. Reading is open to the full admin role set. Acting is the same
 * four roles the request notification goes to (admin, ceo, business_head,
 * sales_head). Marking a bank transfer received is money ARRIVING, not
 * leaving, so it sits with the same set rather than the payout bar.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError, validationError } from "@/lib/nbfc/http-error";
import { resolveAdminActor, statusFromError, ADMIN_ROLES } from "@/lib/nbfc/admin/auth";
import {
  assignRefurbisher,
  cancelLot,
  confirmReceipt,
  costItem,
  estimateLot,
  getLot,
  markArrived,
  markItemReady,
  postMessage,
  recordDispatch,
  recordPickup,
  reviewLotItems,
  sendPi,
  setFinalCost,
  startWork,
  updateLotItem,
} from "@/lib/nbfc/recovery/refurbishment-lots";
import { confirmRefurbOfflinePayment } from "@/lib/nbfc/recovery/refurb-payments";
import { PICKUP_MODES, RECEIPT_CONDITIONS } from "@/lib/nbfc/recovery/refurbishment-lot-status";
import {
  notifyRefurbArrived,
  notifyRefurbAssigned,
  notifyRefurbCancelled,
  notifyRefurbCosted,
  notifyRefurbDispatched,
  notifyRefurbEstimated,
  notifyRefurbFinalBill,
  notifyRefurbMessage,
  notifyRefurbPaymentConfirmed,
  notifyRefurbPiSent,
  notifyRefurbReceived,
  notifyRefurbReviewed,
  notifyRefurbWorkStarted,
} from "@/lib/nbfc/recovery/refurbish-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REFURB_ACT_ROLES = new Set(["admin", "ceo", "business_head", "sales_head"]);

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const Accessory = z.object({
  key: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(80),
  unit_cost: z.number().min(0),
  included: z.boolean(),
});
const Checklist = z.object({
  key: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(120),
  done: z.boolean(),
  note: z.string().trim().max(500).nullable().optional(),
});
const Part = z.object({
  label: z.string().trim().min(1).max(120),
  qty: z.number().min(0).max(1000),
  unit_cost: z.number().min(0).max(10_000_000),
});

const ActionBody = z
  .object({
    action: z.enum([
      "review",
      "estimate",
      "cancel",
      "send-pi",
      "confirm-payment",
      "pickup",
      "arrive",
      "confirm-receipt",
      "assign",
      "start-work",
      "update-item",
      "cost-item",
      "set-final-cost",
      "mark-ready",
      "dispatch",
      "message",
    ]),
    message: z.string().trim().max(2000).optional(),
    // message: which thread
    to: z.enum(["nbfc", "refurbisher"]).optional(),
    // review
    decisions: z.array(z.object({ job_id: z.string().uuid(), decision: z.enum(["accept", "decline"]), reason: z.string().trim().max(1000).nullable().optional() })).max(100).optional(),
    // estimate
    expected_receipt_date: DateStr.optional(),
    expected_return_date: DateStr.optional(),
    pickup_mode: z.enum(PICKUP_MODES as [string, ...string[]]).optional(),
    pickup_address: z.string().trim().max(1000).nullable().optional(),
    workshop_address: z.string().trim().max(1000).nullable().optional(),
    scheduled_pickup_date: DateStr.nullable().optional(),
    advance_pct: z.number().min(0).max(100).optional(),
    items: z
      .array(
        z.object({
          job_id: z.string().uuid(),
          estimated_cost: z.number().min(0).max(10_000_000).optional(),
          accessories: z.array(Accessory).max(20).optional(),
          condition: z.enum(RECEIPT_CONDITIONS).optional(),
          note: z.string().trim().max(1000).nullable().optional(),
          photo_urls: z.array(z.string().max(500)).max(10).optional(),
        }),
      )
      .max(100)
      .optional(),
    // send-pi
    pi_number: z.string().trim().max(64).nullable().optional(),
    pi_url: z.string().max(500).nullable().optional(),
    pi_amount: z.number().min(0).max(100_000_000).optional(),
    pi_advance_pct: z.number().min(0).max(100).optional(),
    bank_details: z
      .object({
        account_name: z.string().trim().max(120).nullable().optional(),
        account_number: z.string().trim().max(34).nullable().optional(),
        ifsc: z.string().trim().max(11).nullable().optional(),
        bank_name: z.string().trim().max(120).nullable().optional(),
        upi: z.string().trim().max(80).nullable().optional(),
      })
      .optional(),
    // confirm-payment
    leg: z.enum(["advance", "balance"]).optional(),
    reference: z.string().trim().min(3).max(120).nullable().optional(),
    // assign
    refurbisher_id: z.string().uuid().optional(),
    // update-item / cost-item / mark-ready
    job_id: z.string().uuid().optional(),
    checklist: z.array(Checklist).max(50).optional(),
    accessories: z.array(Accessory).max(20).optional(),
    refurbisher_parts: z.array(Part).max(50).optional(),
    refurbisher_cost: z.number().min(0).max(10_000_000).nullable().optional(),
    refurbisher_note: z.string().trim().max(2000).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    // set-final-cost
    margin_pct: z.number().min(0).max(100).nullable().optional(),
    margin_amount: z.number().min(0).max(100_000_000).nullable().optional(),
    // pickup / dispatch
    carrier: z.string().trim().max(120).nullable().optional(),
    vehicle_no: z.string().trim().max(32).nullable().optional(),
    docket_no: z.string().trim().max(64).nullable().optional(),
    eway_bill_no: z.string().trim().max(32).nullable().optional(),
    eway_bill_url: z.string().max(500).nullable().optional(),
    dispatched_on: DateStr.optional(),
    photo_urls: z.array(z.string().max(500)).max(20).optional(),
  })
  .strict();

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!(ADMIN_ROLES as readonly string[]).includes(actor.role)) throw new Error("FORBIDDEN: not an admin");
    const { id } = await ctx.params;
    const lot = await getLot(id, null, "admin");
    if (!lot) return NextResponse.json({ ok: false, error: "NOT_FOUND: lot not found" }, { status: 404 });
    return NextResponse.json({ ok: true, lot, can_act: REFURB_ACT_ROLES.has(actor.role) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!REFURB_ACT_ROLES.has(actor.role)) {
      return NextResponse.json({ ok: false, error: `FORBIDDEN: role '${actor.role}' can view refurbishment lots but not act on them` }, { status: 403 });
    }
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
    const actorId = actor.user_id ?? null;
    const bad = (m: string) => NextResponse.json({ ok: false, error: `BAD_REQUEST: ${m}` }, { status: 400 });
    const transport = (dispatched_on: string) => ({
      lot_id: id,
      scope: null,
      actor_user_id: actorId,
      carrier: b.carrier ?? null,
      vehicle_no: b.vehicle_no ?? null,
      docket_no: b.docket_no ?? null,
      eway_bill_no: b.eway_bill_no ?? null,
      eway_bill_url: b.eway_bill_url ?? null,
      dispatched_on,
      note: b.message ?? null,
      photo_urls: b.photo_urls ?? [],
    });

    switch (b.action) {
      case "review": {
        const decisions = b.decisions ?? [];
        const lot = await reviewLotItems({ lot_id: id, actor_user_id: actorId, decisions, note: b.message ?? null });
        if (lot.status === "cancelled") await notifyRefurbCancelled(lot, "admin", "every battery was declined");
        else {
          const declined = decisions.filter((d) => d.decision === "decline");
          await notifyRefurbReviewed(lot, declined.length, declined.map((d) => d.reason ?? "").filter(Boolean));
        }
        return NextResponse.json({ ok: true, lot });
      }
      case "estimate": {
        if (!b.expected_receipt_date || !b.expected_return_date) return bad("both dates are required");
        if (!b.items?.length) return bad("a per-battery estimate is required");
        const items = b.items.map((i) => {
          if (i.estimated_cost === undefined) throw new Error(`BAD_REQUEST: estimated_cost missing for job ${i.job_id}`);
          return { job_id: i.job_id, estimated_cost: i.estimated_cost, accessories: i.accessories };
        });
        const lot = await estimateLot({
          lot_id: id,
          actor_user_id: actorId,
          expected_receipt_date: b.expected_receipt_date,
          expected_return_date: b.expected_return_date,
          items,
          note: b.message ?? null,
          pickup_mode: (b.pickup_mode as "nbfc_ships" | "itarang_pickup" | undefined) ?? "nbfc_ships",
          pickup_address: b.pickup_address ?? null,
          workshop_address: b.workshop_address ?? null,
          scheduled_pickup_date: b.scheduled_pickup_date ?? null,
          advance_pct: b.advance_pct ?? 0,
        });
        await notifyRefurbEstimated(lot);
        return NextResponse.json({ ok: true, lot });
      }
      case "cancel": {
        const lot = await cancelLot({ lot_id: id, tenant_id: null, actor_user_id: actorId, party: "admin", reason: b.message ?? null });
        await notifyRefurbCancelled(lot, "admin", b.message ?? null);
        return NextResponse.json({ ok: true, lot });
      }
      case "send-pi": {
        if (b.pi_amount === undefined) return bad("pi_amount is required");
        const before = await getLot(id, null, "admin");
        const lot = await sendPi({
          lot_id: id,
          actor_user_id: actorId,
          pi_number: b.pi_number ?? null,
          pi_url: b.pi_url ?? null,
          pi_amount: b.pi_amount,
          pi_advance_pct: b.pi_advance_pct,
          bank_details: b.bank_details ?? {},
          note: b.message ?? null,
        });
        await notifyRefurbPiSent(lot, !!before?.pi.sent_at);
        return NextResponse.json({ ok: true, lot });
      }
      case "confirm-payment": {
        if (!b.leg) return bad("leg is required");
        const lot = await confirmRefurbOfflinePayment({ lot_id: id, actor_user_id: actorId, leg: b.leg, reference: b.reference ?? null, note: b.message ?? null });
        await notifyRefurbPaymentConfirmed(lot, b.leg);
        return NextResponse.json({ ok: true, lot });
      }
      case "pickup": {
        if (!b.dispatched_on) return bad("dispatched_on (pickup date) is required");
        const lot = await recordPickup(transport(b.dispatched_on));
        await notifyRefurbDispatched(lot, "out", "picked_up", "admin");
        return NextResponse.json({ ok: true, lot });
      }
      case "arrive": {
        const lot = await markArrived({ lot_id: id, scope: null, actor_user_id: actorId, leg: "out", note: b.message ?? null });
        await notifyRefurbArrived(lot, "out");
        return NextResponse.json({ ok: true, lot });
      }
      case "confirm-receipt": {
        if (!b.items?.length) return bad("items are required");
        const items = b.items.map((i) => {
          if (!i.condition) throw new Error(`BAD_REQUEST: condition missing for job ${i.job_id}`);
          return { job_id: i.job_id, condition: i.condition, note: i.note ?? null, photo_urls: i.photo_urls };
        });
        const lot = await confirmReceipt({ lot_id: id, scope: null, actor_user_id: actorId, leg: "out", items, note: b.message ?? null, photo_urls: b.photo_urls ?? [] });
        const tally = { received: 0, damaged: 0, missing: 0 };
        for (const it of items) tally[it.condition]++;
        await notifyRefurbReceived(lot, "out", tally);
        return NextResponse.json({ ok: true, lot });
      }
      case "assign": {
        if (!b.refurbisher_id) return bad("refurbisher_id is required");
        const before = await getLot(id, null, "admin");
        const lot = await assignRefurbisher({ lot_id: id, actor_user_id: actorId, refurbisher_id: b.refurbisher_id, note: b.message ?? null });
        await notifyRefurbAssigned(lot, !!before?.refurbisher && before.refurbisher.id !== b.refurbisher_id);
        return NextResponse.json({ ok: true, lot });
      }
      case "start-work": {
        const lot = await startWork({ lot_id: id, scope: null, actor_user_id: actorId, party: "admin" });
        await notifyRefurbWorkStarted(lot);
        return NextResponse.json({ ok: true, lot });
      }
      case "update-item": {
        if (!b.job_id) return bad("job_id is required");
        const lot = await updateLotItem({ lot_id: id, job_id: b.job_id, scope: null, actor_user_id: actorId, checklist: b.checklist, accessories: b.accessories, refurbisher_parts: b.refurbisher_parts, refurbisher_cost: b.refurbisher_cost, refurbisher_note: b.refurbisher_note, notes: b.notes });
        return NextResponse.json({ ok: true, lot });
      }
      case "cost-item": {
        if (!b.job_id) return bad("job_id is required");
        if (b.refurbisher_cost == null) return bad("refurbisher_cost is required");
        const lot = await costItem({ lot_id: id, job_id: b.job_id, scope: null, actor_user_id: actorId, party: "admin", refurbisher_cost: b.refurbisher_cost, refurbisher_parts: b.refurbisher_parts, checklist: b.checklist, accessories: b.accessories, note: b.refurbisher_note ?? b.message ?? null });
        if (lot.status === "costed" && lot.events.at(-1)?.kind === "all_costed") await notifyRefurbCosted(lot);
        return NextResponse.json({ ok: true, lot });
      }
      case "set-final-cost": {
        const lot = await setFinalCost({ lot_id: id, actor_user_id: actorId, margin_pct: b.margin_pct ?? null, margin_amount: b.margin_amount ?? null, note: b.message ?? null });
        await notifyRefurbFinalBill(lot);
        return NextResponse.json({ ok: true, lot });
      }
      case "mark-ready": {
        if (!b.job_id) return bad("job_id is required");
        const lot = await markItemReady({ lot_id: id, job_id: b.job_id, actor_user_id: actorId });
        return NextResponse.json({ ok: true, lot });
      }
      case "dispatch": {
        if (!b.dispatched_on) return bad("dispatched_on is required");
        const lot = await recordDispatch({ ...transport(b.dispatched_on), leg: "return", party: "admin" });
        await notifyRefurbDispatched(lot, "return", "dispatched", "admin");
        return NextResponse.json({ ok: true, lot });
      }
      case "message": {
        if (!b.message?.trim()) return bad("message is required");
        const to = b.to ?? "nbfc";
        const lot = await postMessage({ lot_id: id, scope: null, actor_user_id: actorId, party: "admin", message: b.message, to });
        await notifyRefurbMessage(lot, "admin", b.message, to);
        return NextResponse.json({ ok: true, lot });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}
