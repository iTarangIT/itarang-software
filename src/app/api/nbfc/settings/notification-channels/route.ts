/**
 * GET/PUT /api/nbfc/settings/notification-channels — per-NBFC Email/SMS/WhatsApp
 * gateway configuration (BRD Addendum V0.3.1 §15.5). GET is open to any tenant
 * member; PUT requires the `settings.notification_channels` permission.
 *
 * Secrets are returned masked on GET (never echo the stored password/api key) so
 * the settings screen can show "configured" without leaking the value.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcNotificationChannels } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

const SECRET_SENTINEL = "__UNCHANGED__"; // PUT sends this to keep an existing secret

const Body = z.object({
  email_mode: z.enum(["itarang_default", "own_smtp"]),
  email_from: z.string().optional().nullable(),
  email_from_name: z.string().optional().nullable(),
  smtp_host: z.string().optional().nullable(),
  smtp_port: z.union([z.number(), z.string()]).optional().nullable(),
  smtp_user: z.string().optional().nullable(),
  smtp_pass: z.string().optional().nullable(),
  smtp_secure: z.boolean().optional(),
  sms_provider: z.enum(["itarang_default", "gupshup", "decentro"]),
  sms_api_key: z.string().optional().nullable(),
  sms_source: z.string().optional().nullable(),
  sms_dlt_template_id: z.string().optional().nullable(),
  whatsapp_enabled: z.boolean().optional(),
  whatsapp_provider: z.string().optional().nullable(),
  whatsapp_waba_id: z.string().optional().nullable(),
  whatsapp_api_key: z.string().optional().nullable(),
  whatsapp_from: z.string().optional().nullable(),
});

const mask = (v: string | null | undefined): boolean => Boolean(v && v.length > 0);

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const [row] = await db
      .select()
      .from(nbfcNotificationChannels)
      .where(eq(nbfcNotificationChannels.tenant_id, actor.tenant_id))
      .limit(1);
    return NextResponse.json({
      ok: true,
      canEdit: actor.can("settings.notification_channels"),
      config: {
        email_mode: row?.email_mode ?? "itarang_default",
        email_from: row?.email_from ?? null,
        email_from_name: row?.email_from_name ?? null,
        smtp_host: row?.smtp_host ?? null,
        smtp_port: row?.smtp_port ?? null,
        smtp_user: row?.smtp_user ?? null,
        smtp_pass_set: mask(row?.smtp_pass),
        smtp_secure: row?.smtp_secure ?? false,
        sms_provider: row?.sms_provider ?? "itarang_default",
        sms_source: row?.sms_source ?? null,
        sms_dlt_template_id: row?.sms_dlt_template_id ?? null,
        sms_api_key_set: mask(row?.sms_api_key),
        whatsapp_enabled: row?.whatsapp_enabled ?? false,
        whatsapp_provider: row?.whatsapp_provider ?? null,
        whatsapp_waba_id: row?.whatsapp_waba_id ?? null,
        whatsapp_from: row?.whatsapp_from ?? null,
        whatsapp_api_key_set: mask(row?.whatsapp_api_key),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (!actor.can("settings.notification_channels")) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN: settings.notification_channels required" }, { status: 403 });
    }
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }
    const d = parsed.data;
    if (d.email_mode === "own_smtp" && (!d.smtp_host || !d.smtp_port || !d.smtp_user)) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: own SMTP requires host, port and user" }, { status: 400 });
    }

    // Load existing to preserve secrets the client left as the sentinel.
    const [existing] = await db
      .select()
      .from(nbfcNotificationChannels)
      .where(eq(nbfcNotificationChannels.tenant_id, actor.tenant_id))
      .limit(1);
    const keep = (incoming: string | null | undefined, current: string | null | undefined) =>
      incoming === SECRET_SENTINEL ? (current ?? null) : (incoming ?? null);

    const now = new Date();
    const values = {
      tenant_id: actor.tenant_id,
      email_mode: d.email_mode,
      email_from: d.email_from ?? null,
      email_from_name: d.email_from_name ?? null,
      smtp_host: d.smtp_host ?? null,
      smtp_port: d.smtp_port == null || d.smtp_port === "" ? null : Number(d.smtp_port),
      smtp_user: d.smtp_user ?? null,
      smtp_pass: keep(d.smtp_pass, existing?.smtp_pass),
      smtp_secure: d.smtp_secure ?? false,
      sms_provider: d.sms_provider,
      sms_api_key: keep(d.sms_api_key, existing?.sms_api_key),
      sms_source: d.sms_source ?? null,
      sms_dlt_template_id: d.sms_dlt_template_id ?? null,
      whatsapp_enabled: d.whatsapp_enabled ?? false,
      whatsapp_provider: d.whatsapp_provider ?? null,
      whatsapp_waba_id: d.whatsapp_waba_id ?? null,
      whatsapp_api_key: keep(d.whatsapp_api_key, existing?.whatsapp_api_key),
      whatsapp_from: d.whatsapp_from ?? null,
      updated_at: now,
    };

    await db
      .insert(nbfcNotificationChannels)
      .values(values)
      .onConflictDoUpdate({ target: nbfcNotificationChannels.tenant_id, set: values });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
