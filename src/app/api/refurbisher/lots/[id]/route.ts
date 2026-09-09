/**
 * E-292 — one refurbishment lot, from the REFURBISHER's side (steps 11–12, 14).
 *
 *   GET   — the lot, its batteries, both legs, timeline. REDACTED: no money,
 *           no PI, no NBFC-facing figures. Scoped to users.refurbisher_id —
 *           another partner's lot is a 404.
 *   POST  — the refurbisher's moves:
 *             start-work | update-item | cost-item (final cost per battery)
 *             dispatch (return leg; e-way bill optional) | message (to iTarang)
 *
 * NOTIFICATIONS FIRE HERE, NOT IN THE SERVICE.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError, validationError } from "@/lib/nbfc/http-error";
import { requireRefurbisher, refurbisherStatusFromError } from "@/lib/refurbisher/auth";
import {
  costItem,
  getLot,
  postMessage,
  recordDispatch,
  startWork,
  updateLotItem,
} from "@/lib/nbfc/recovery/refurbishment-lots";
import {
  notifyRefurbCosted,
  notifyRefurbDispatched,
  notifyRefurbMessage,
  notifyRefurbWorkStarted,
} from "@/lib/nbfc/recovery/refurbish-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const Accessory = z.object({ key: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(80), unit_cost: z.number().min(0), included: z.boolean() });
const Checklist = z.object({ key: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(120), done: z.boolean(), note: z.string().trim().max(500).nullable().optional() });
const Part = z.object({ label: z.string().trim().min(1).max(120), qty: z.number().min(0).max(1000), unit_cost: z.number().min(0).max(10_000_000) });

const ActionBody = z
  .object({
    action: z.enum(["start-work", "update-item", "cost-item", "dispatch", "message"]),
    message: z.string().trim().max(2000).optional(),
    job_id: z.string().uuid().optional(),
    checklist: z.array(Checklist).max(50).optional(),
    accessories: z.array(Accessory).max(20).optional(),
    refurbisher_parts: z.array(Part).max(50).optional(),
    refurbisher_cost: z.number().min(0).max(10_000_000).nullable().optional(),
    refurbisher_note: z.string().trim().max(2000).nullable().optional(),
    carrier: z.string().trim().max(120).nullable().optional(),
    vehicle_no: z.string().trim().max(32).nullable().optional(),
    docket_no: z.string().trim().max(64).nullable().optional(),
    eway_bill_no: z.string().trim().max(32).nullable().optional(),
    eway_bill_url: z.string().max(500).nullable().optional(),
    dispatched_on: DateStr.optional(),
    photo_urls: z.array(z.string().max(500)).max(20).optional(),
  })
  .strict();

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireRefurbisher();
    const { id } = await ctx.params;
    const lot = await getLot(id, { refurbisher_id: actor.refurbisher_id }, "refurbisher");
    if (!lot) return NextResponse.json({ ok: false, error: "NOT_FOUND: lot not found" }, { status: 404 });
    return NextResponse.json({ ok: true, lot, can_act: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: refurbisherStatusFromError(e) });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireRefurbisher();
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
    const scope = { refurbisher_id: actor.refurbisher_id };
    const bad = (m: string) => NextResponse.json({ ok: false, error: `BAD_REQUEST: ${m}` }, { status: 400 });

    switch (b.action) {
      case "start-work": {
        const lot = await startWork({ lot_id: id, scope, actor_user_id: actor.user_id, party: "refurbisher" });
        await notifyRefurbWorkStarted(lot);
        return NextResponse.json({ ok: true, lot });
      }
      case "update-item": {
        if (!b.job_id) return bad("job_id is required");
        const lot = await updateLotItem({ lot_id: id, job_id: b.job_id, scope, actor_user_id: actor.user_id, checklist: b.checklist, accessories: b.accessories, refurbisher_parts: b.refurbisher_parts, refurbisher_cost: b.refurbisher_cost, refurbisher_note: b.refurbisher_note });
        return NextResponse.json({ ok: true, lot });
      }
      case "cost-item": {
        if (!b.job_id) return bad("job_id is required");
        if (b.refurbisher_cost == null) return bad("refurbisher_cost is required");
        const lot = await costItem({ lot_id: id, job_id: b.job_id, scope, actor_user_id: actor.user_id, party: "refurbisher", refurbisher_cost: b.refurbisher_cost, refurbisher_parts: b.refurbisher_parts, checklist: b.checklist, accessories: b.accessories, note: b.refurbisher_note ?? b.message ?? null });
        if (lot.status === "costed" && lot.events.at(-1)?.kind === "all_costed") {
          // Admin's copy carries the figures; re-read unredacted for the notification.
          const full = await getLot(id, null, "admin");
          if (full) await notifyRefurbCosted(full);
        }
        return NextResponse.json({ ok: true, lot });
      }
      case "dispatch": {
        if (!b.dispatched_on) return bad("dispatched_on is required");
        const lot = await recordDispatch({
          lot_id: id,
          scope,
          actor_user_id: actor.user_id,
          leg: "return",
          party: "refurbisher",
          carrier: b.carrier ?? null,
          vehicle_no: b.vehicle_no ?? null,
          docket_no: b.docket_no ?? null,
          eway_bill_no: b.eway_bill_no ?? null,
          eway_bill_url: b.eway_bill_url ?? null,
          dispatched_on: b.dispatched_on,
          note: b.message ?? null,
          photo_urls: b.photo_urls ?? [],
        });
        const full = await getLot(id, null, "admin");
        if (full) await notifyRefurbDispatched(full, "return", "dispatched", "refurbisher");
        return NextResponse.json({ ok: true, lot });
      }
      case "message": {
        if (!b.message?.trim()) return bad("message is required");
        const lot = await postMessage({ lot_id: id, scope, actor_user_id: actor.user_id, party: "refurbisher", message: b.message });
        const full = await getLot(id, null, "admin");
        if (full) await notifyRefurbMessage(full, "refurbisher", b.message);
        return NextResponse.json({ ok: true, lot });
      }
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: refurbisherStatusFromError(e) });
  }
}
