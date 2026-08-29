/**
 * E-233 — PATCH /api/nbfc/recovery/refurbishment/[id]
 *
 * Advances or edits one refurbishment job.
 *
 * The status transitions are requested -> in_progress -> returned, with
 * `cancelled` reachable from either open state. On `returned` the battery moves
 * to `ready` and the pipeline row to `ready_for_auction`; on `cancelled` the
 * battery returns to `inspected`, because a cancelled job means the work did
 * NOT happen and calling it refurbished would put an unrepaired battery into a
 * lot under the wrong grade.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  REFURB_STATUSES,
  listRefurbishmentJobs,
  updateRefurbishmentJob,
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
    status: z.enum(REFURB_STATUSES).optional(),
    assigned_workshop: z.string().trim().max(160).nullable().optional(),
    checklist: z.array(ChecklistSchema).max(50).optional(),
    accessories: z.array(AccessorySchema).max(20).optional(),
    actual_cost: z.number().min(0).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "nothing to update",
  });

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;

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

    // [E-270] Workshop transitions belong to iTarang. The NBFC may still
    // cancel a legacy single job and edit its notes/accessories; it may not
    // declare work started, a battery ready, or a battery returned — those are
    // recorded by the admin desk (and for lot items, by the receipt flow).
    const wanted = parsed.data.status;
    if (wanted && wanted !== "cancelled") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "FORBIDDEN: workshop transitions (in_progress / ready / returned) are recorded by iTarang, not the NBFC",
        },
        { status: 403 },
      );
    }
    if (parsed.data.status || parsed.data.actual_cost !== undefined) {
      const current = (await listRefurbishmentJobs({ tenant_id: actor.tenant_id, status: "all" })).find(
        (j) => j.id === id,
      );
      if (current?.lot_id) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "FORBIDDEN: this job belongs to a refurbishment lot — act on the lot instead (/nbfc/recovery/refurbishment)",
          },
          { status: 403 },
        );
      }
    }

    const job = await updateRefurbishmentJob({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
      job_id: id,
      ...parsed.data,
    });

    return NextResponse.json({ ok: true, job });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
