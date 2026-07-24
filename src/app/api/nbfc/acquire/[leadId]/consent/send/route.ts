/**
 * POST /api/nbfc/acquire/[leadId]/consent/send
 *
 * Change 7 — the NBFC re-initiates DPDP consent capture ITSELF for the customer
 * or the co-borrower, choosing the method: e-sign (Digio Aadhaar) or OTP. Fully
 * reuses src/lib/kyc/consent-service.ts; the NBFC actor is recorded as the
 * requester on the OTP path.
 *
 * Body: { method: 'esign'|'otp', consentFor: 'customer'|'borrower', channel }
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { nbfcServiceConfig } from "@/lib/db/schema";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { getNbfcObject } from "@/lib/nbfc/nbfc-storage";
import { sendConsentForLead, sendConsentOtp } from "@/lib/kyc/consent-service";
import { notifyConsentSent } from "@/lib/notifications/events";
import { tenantDisplayName } from "@/lib/notifications/emit";
import { nbfcParty } from "@/lib/notifications/provenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

const Body = z
  .object({
    method: z.enum(["esign", "otp"]),
    consentFor: z.enum(["customer", "borrower"]).default("customer"),
    channel: z.enum(["call", "sms", "whatsapp", "email"]).default("sms"),
    dealerName: z.string().optional(),
  })
  .superRefine((d, ctx) => {
    // Digio e-sign is delivered by sms/whatsapp/email only (no voice call).
    if (d.method === "esign" && d.channel === "call") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["channel"],
        message: "e-sign supports sms, whatsapp or email only",
      });
    }
  });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;
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

    const actor = await resolveActor(req.headers);
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot initiate consent` },
        { status: 403 },
      );
    }
    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no assignment for this lead under this tenant" },
        { status: 400 },
      );
    }

    // e-sign / OTP sign the NBFC's OWN consent template (uploaded in Settings).
    // Block if the NBFC hasn't configured one — no fallback to the iTarang PDF.
    const [cfg] = await db
      .select({ url: nbfcServiceConfig.consent_template_url })
      .from(nbfcServiceConfig)
      .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
      .limit(1);
    if (!cfg?.url) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "BAD_REQUEST: no consent template configured. Upload your consent document in Settings first.",
        },
        { status: 400 },
      );
    }
    const bytes = await getNbfcObject(cfg.url);
    if (!bytes) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "BAD_REQUEST: the configured consent template could not be read. Re-upload it in Settings.",
        },
        { status: 400 },
      );
    }
    const documentOverride = {
      pdfBase64: bytes.toString("base64"),
      fileName: `nbfc_consent_${actor.tenant_slug}.pdf`,
      url: cfg.url,
    };

    if (d.method === "esign") {
      const result = await sendConsentForLead({
        leadId,
        // 'call' is not a valid e-sign channel (guarded above); fall back to sms.
        channel: d.channel === "call" ? "sms" : d.channel,
        consentFor: d.consentFor,
        dealerName: d.dealerName,
        documentOverride,
        initiatedByTenantId: actor.tenant_id,
      });
      await notifyConsentSent({
        leadId,
        channel: d.channel,
        sentBy: nbfcParty(await tenantDisplayName(actor.tenant_id)),
      });
      return NextResponse.json({ ok: true, method: "esign", result });
    }

    const result = await sendConsentOtp({
      leadId,
      channel: d.channel,
      consentFor: d.consentFor,
      dealerName: d.dealerName,
      requestedBy: actor.user_id,
      documentOverride,
      initiatedByTenantId: actor.tenant_id,
    });
    await notifyConsentSent({
      leadId,
      channel: d.channel,
      sentBy: nbfcParty(await tenantDisplayName(actor.tenant_id)),
    });
    return NextResponse.json({ ok: true, method: "otp", result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
