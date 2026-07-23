/**
 * GET /api/nbfc/acquire/[leadId]/consent
 *
 * Change 7 — the NBFC's view/track surface for DPDP consent. Returns the latest
 * consent record per applicant (customer + co-borrower) for the lead. Read-only;
 * the NBFC re-initiates via /consent/send.
 *
 * Role: credit_underwriting | nbfc_admin, scoped to the acting tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { consentRecords, nbfcServiceConfig } from "@/lib/db/schema";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no assignment for this tenant" },
        { status: 400 },
      );
    }

    // Req 1 — the NBFC only sees the consent IT captured (tagged with its tenant).
    // iTarang / dealer-captured consent (initiated_by_tenant_id NULL) is hidden.
    const rows = await db
      .select({
        consent_for: consentRecords.consent_for,
        consent_type: consentRecords.consent_type,
        consent_status: consentRecords.consent_status,
        sign_method: consentRecords.sign_method,
        signed_at: consentRecords.signed_at,
        signed_consent_url: consentRecords.signed_consent_url,
        generated_pdf_url: consentRecords.generated_pdf_url,
        consent_link_url: consentRecords.consent_link_url,
        created_at: consentRecords.created_at,
        updated_at: consentRecords.updated_at,
      })
      .from(consentRecords)
      .where(
        and(
          eq(consentRecords.lead_id, leadId),
          eq(consentRecords.initiated_by_tenant_id, actor.tenant_id),
        ),
      )
      .orderBy(desc(consentRecords.created_at));

    // Latest per applicant.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const key = r.consent_for ?? "primary";
      if (!latest.has(key)) latest.set(key, r);
    }

    // Req 3 — the NBFC's own consent template (uploaded in Settings) for the card.
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
      consents: Array.from(latest.values()),
      consentTemplate: cfg?.url ? { url: cfg.url, size: cfg.size ?? null } : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
