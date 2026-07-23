/**
 * GET/POST/DELETE /api/nbfc/settings/consent-template
 *
 * The NBFC's own DPDP consent-template PDF — uploaded once, reused across all
 * leads for the Acquire e-sign/OTP consent flow (E-205). Stored in the private
 * nbfc-documents bucket; the `/nbfc-uploads/<key>` proxy path is persisted on
 * `nbfc_service_config.consent_template_url` (keyed per tenant, uuid).
 *
 *   GET    — current template { url, size } for the acting tenant (or null).
 *   POST   — multipart upload (PDF only, ≤15 MB). Requires the `nbfc_admin` role.
 *   DELETE — clear the template. Requires `nbfc_admin`.
 *
 * AuthN/Z via resolveActor() — same pattern as settings/service-config.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcServiceConfig } from "@/lib/db/schema";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { putNbfcObject } from "@/lib/nbfc/nbfc-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const [cfg] = await db
      .select({
        url: nbfcServiceConfig.consent_template_url,
        size: nbfcServiceConfig.consent_template_size,
      })
      .from(nbfcServiceConfig)
      .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
      .limit(1);
    return NextResponse.json({
      ok: true,
      template: cfg?.url ? { url: cfg.url, size: cfg.size ?? null } : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: caller role '${actor.role}' is not authorised; nbfc_admin required` },
        { status: 403 },
      );
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: expected multipart/form-data" },
        { status: 400 },
      );
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: a consent template PDF is required" },
        { status: 400 },
      );
    }
    if (file.type !== "application/pdf") {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: the consent template must be a PDF" },
        { status: 400 },
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: file exceeds the 15 MB limit" },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const now = new Date();
    const key = `${actor.tenant_id}/consent-template/${now.getTime()}.pdf`;
    const { url } = await putNbfcObject(key, buffer, "application/pdf", { upsert: true });

    await db
      .insert(nbfcServiceConfig)
      .values({
        tenant_id: actor.tenant_id,
        consent_template_url: url,
        consent_template_size: buffer.length,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: nbfcServiceConfig.tenant_id,
        set: {
          consent_template_url: url,
          consent_template_size: buffer.length,
          updated_at: now,
        },
      });

    return NextResponse.json({ ok: true, template: { url, size: buffer.length } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: caller role '${actor.role}' is not authorised; nbfc_admin required` },
        { status: 403 },
      );
    }
    const now = new Date();
    // Only clears the reference (the object stays in the bucket, harmless).
    await db
      .update(nbfcServiceConfig)
      .set({ consent_template_url: null, consent_template_size: null, updated_at: now })
      .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
