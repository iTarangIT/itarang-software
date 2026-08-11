/**
 * E-233 — /api/nbfc/recovery/refurbishment (Battery Auction BRD §5, §15)
 *
 * GET  — list the caller tenant's refurbishment jobs.
 * POST — raise a job against one of the tenant's recovered batteries.
 *
 * Refurbishment is RECOMMENDED, NEVER MANDATORY — a battery can go from
 * inspection straight to auction without ever touching this route.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  REFURB_STATUSES,
  createRefurbishmentJob,
  listRefurbishmentJobs,
} from "@/lib/nbfc/recovery/refurbishment";

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

const AccessorySchema = z.object({
  key: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(80),
  unit_cost: z.number().min(0),
  included: z.boolean(),
});

const ChecklistSchema = z.object({
  key: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(120),
  done: z.boolean(),
  note: z.string().trim().max(500).nullable().optional(),
});

const Body = z
  .object({
    battery_id: z.string().uuid(),
    assigned_workshop: z.string().trim().max(160).optional(),
    estimated_cost: z.number().min(0).optional(),
    checklist: z.array(ChecklistSchema).max(50).optional(),
    accessories: z.array(AccessorySchema).max(20).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? "all";
    const battery_id = url.searchParams.get("battery_id") ?? undefined;

    const parsed = z
      .enum([...REFURB_STATUSES, "open", "all"])
      .safeParse(status);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const items = await listRefurbishmentJobs({
      tenant_id: actor.tenant_id,
      status: parsed.data,
      battery_id,
    });

    return NextResponse.json({ ok: true, items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);

    let raw: unknown;
    try {
      const text = await req.text();
      raw = text ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }

    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const job = await createRefurbishmentJob({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
      ...parsed.data,
    });

    return NextResponse.json({ ok: true, job }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
