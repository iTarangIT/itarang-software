/**
 * E-292 — POST /api/nbfc/recovery/batteries/[id]/triage (refurbish flow v3, R2/R3)
 *
 *   { action: "record", rated_voltage_v, measured_voltage_v, condition?, note? }
 *       → health % + the system's suggestion, battery `inspected`
 *   { action: "choose", choice: auction | redeploy | refurbish | scrap, note? }
 *       → moves the pipeline row down that branch (refurbish is refused under
 *         the 70% floor). `redeploy` is a stub: recorded, and iTarang is told.
 *
 * AuthN/Z: resolveActor — an NBFC session, scoped to its own tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError, validationError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { chooseTriage, recordTriage } from "@/lib/nbfc/recovery/triage";
import { TRIAGE_CHOICES, TRIAGE_CONDITIONS } from "@/lib/nbfc/recovery/triage-rules";
import { ADMIN_AUDIENCE_ROLES, emit } from "@/lib/notifications/emit";
import { ADMIN_PARTY, nbfcParty } from "@/lib/notifications/provenance";

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

const Body = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("record"),
      rated_voltage_v: z.number().positive().max(1000),
      measured_voltage_v: z.number().min(0).max(1000),
      condition: z.enum(TRIAGE_CONDITIONS).nullable().optional(),
      note: z.string().trim().max(2000).nullable().optional(),
      photo_paths: z.array(z.string().max(500)).max(10).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("choose"),
      choice: z.enum(TRIAGE_CHOICES),
      note: z.string().trim().max(2000).nullable().optional(),
    })
    .strict(),
]);

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
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: validationError(parsed.error), issues: parsed.error.issues }, { status: 400 });
    }
    const b = parsed.data;
    if (b.action === "record") {
      const result = await recordTriage({
        tenant_id: actor.tenant_id,
        actor_user_id: actor.user_id,
        battery_id: id,
        rated_voltage_v: b.rated_voltage_v,
        measured_voltage_v: b.measured_voltage_v,
        condition: b.condition ?? null,
        note: b.note ?? null,
        photo_paths: b.photo_paths,
      });
      return NextResponse.json({ ok: true, ...result });
    }
    const result = await chooseTriage({ tenant_id: actor.tenant_id, actor_user_id: actor.user_id, battery_id: id, choice: b.choice, note: b.note ?? null });
    if (b.choice === "redeploy") {
      // The stub's one real effect: iTarang is told and gets in touch.
      await emit({
        type: "refurb.redeploy_requested",
        title: `Redeploy request: battery ${result.battery.serial}`,
        message: `${actor.tenant_slug ?? "An NBFC"} triaged battery ${result.battery.serial} (health ${result.health_pct ?? "—"}%) as fit as-is and chose to REDEPLOY it rather than auction. iTarang's help was requested.${b.note ? ` "${b.note}"` : ""}`,
        stage: "Recovery",
        from: nbfcParty(actor.tenant_slug ?? "NBFC"),
        data: { battery_id: id, serial: result.battery.serial, health_pct: result.health_pct, tenant_id: actor.tenant_id },
        to: [{ audience: { kind: "roles", roles: ADMIN_AUDIENCE_ROLES }, as: ADMIN_PARTY, href: "/admin/nbfc/refurbishment" }],
      });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}
