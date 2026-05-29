/**
 * GET/PUT /api/nbfc/settings/service-config
 *
 * BRD Addendum V0.2 §7.4 — per-NBFC Service Opt-In + document/track config.
 *
 * GET  — current tenant's config, or an all-off default object if none exists.
 * PUT  — upsert (one row per tenant). Mutating requires the `nbfc_admin` role
 *        (§7.2: "NBFC Admin manages NBFC users and configuration").
 *
 * AuthN/Z via resolveActor() — same pattern as the dual-approval action routes.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcServiceConfig } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULTS = {
  fi_enabled: false,
  vkyc_enabled: false,
  vkyc_mode: null as "own" | "itarang" | null,
  enach_enabled: false,
  enach_handoff_method: null as "redirect" | "webhook" | null,
  enach_endpoint_url: null as string | null,
  doc_agreement_method: null as "upload" | "digio" | "api_autofetch" | null,
  store_sanction_letter: false,
  store_loan_agreement: false,
  track_completion_gate: true,
  track_failure_halts: false,
};

const Body = z.object({
  fi_enabled: z.boolean(),
  vkyc_enabled: z.boolean(),
  vkyc_mode: z.enum(["own", "itarang"]).nullable().optional(),
  enach_enabled: z.boolean(),
  enach_handoff_method: z.enum(["redirect", "webhook"]).nullable().optional(),
  enach_endpoint_url: z.string().url().max(2048).nullable().optional(),
  doc_agreement_method: z.enum(["upload", "digio", "api_autofetch"]).nullable().optional(),
  store_sanction_letter: z.boolean(),
  store_loan_agreement: z.boolean(),
  track_completion_gate: z.boolean(),
  track_failure_halts: z.boolean(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const rows = await db
      .select()
      .from(nbfcServiceConfig)
      .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
      .limit(1);
    const config = rows[0] ?? { tenant_id: actor.tenant_id, ...DEFAULTS };
    return NextResponse.json({ ok: true, config });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}

export async function PUT(req: NextRequest) {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const actor = await resolveActor(req.headers);
    if (actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: caller role '${actor.role}' is not authorised; nbfc_admin required` },
        { status: 403 },
      );
    }

    const d = parsed.data;
    // When a service is opted IN, its required config must be present.
    if (d.vkyc_enabled && !d.vkyc_mode) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: vkyc_mode is required when Video KYC is enabled" },
        { status: 400 },
      );
    }
    if (d.enach_enabled && (!d.enach_handoff_method || !d.enach_endpoint_url)) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: enach_handoff_method and enach_endpoint_url are required when E-NACH is enabled" },
        { status: 400 },
      );
    }

    const now = new Date();
    const values = {
      tenant_id: actor.tenant_id,
      fi_enabled: d.fi_enabled,
      vkyc_enabled: d.vkyc_enabled,
      vkyc_mode: d.vkyc_mode ?? null,
      enach_enabled: d.enach_enabled,
      enach_handoff_method: d.enach_handoff_method ?? null,
      enach_endpoint_url: d.enach_endpoint_url ?? null,
      doc_agreement_method: d.doc_agreement_method ?? null,
      store_sanction_letter: d.store_sanction_letter,
      store_loan_agreement: d.store_loan_agreement,
      track_completion_gate: d.track_completion_gate,
      track_failure_halts: d.track_failure_halts,
      updated_at: now,
    };

    await db
      .insert(nbfcServiceConfig)
      .values(values)
      .onConflictDoUpdate({
        target: nbfcServiceConfig.tenant_id,
        set: {
          fi_enabled: values.fi_enabled,
          vkyc_enabled: values.vkyc_enabled,
          vkyc_mode: values.vkyc_mode,
          enach_enabled: values.enach_enabled,
          enach_handoff_method: values.enach_handoff_method,
          enach_endpoint_url: values.enach_endpoint_url,
          doc_agreement_method: values.doc_agreement_method,
          store_sanction_letter: values.store_sanction_letter,
          store_loan_agreement: values.store_loan_agreement,
          track_completion_gate: values.track_completion_gate,
          track_failure_halts: values.track_failure_halts,
          updated_at: now,
        },
      });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
