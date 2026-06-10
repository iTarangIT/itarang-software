/**
 * Public callback for the "own e-sign" handoff (E-165, §17 loan agreement).
 *
 * The NBFC's own e-sign platform posts the result here after the customer signs.
 * We match by the opaque `itarang_agreement_ref` minted at handoff time and
 * update the latest attempt for that ref. The NBFC maps its provider's status
 * into iTarang's CANONICAL agreement states before posting; the provider raw
 * layer is retained for display/audit only.
 *
 * Authenticity: if the tenant has an `esign_webhook_secret` configured AND the
 * caller sent `X-iTarang-Signature`, the HMAC must match (else 401). When no
 * secret is set the rail is match-by-ref (mirrors the E-NACH callback). We
 * otherwise always 200 so the NBFC integration never retries endlessly.
 *
 * Document storage honours §17.4: signed_document_url is stored only when the
 * NBFC opted into `store_loan_agreement`; the audit_trail_url is always kept.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcLoanAgreements, nbfcServiceConfig } from "@/lib/db/schema";
import { AGREEMENT_STATES, type AgreementState } from "@/lib/nbfc/agreement";
import { verifyInboundSignature } from "@/lib/nbfc/handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pickStr(body: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    const url = new URL(req.url);
    const ref =
      pickStr(body, "itarang_agreement_ref", "agreement_ref", "ref") ||
      url.searchParams.get("ref") ||
      url.searchParams.get("itarang_agreement_ref");
    if (!ref) {
      return new NextResponse("Missing itarang_agreement_ref", { status: 400 });
    }

    const [row] = await db
      .select()
      .from(nbfcLoanAgreements)
      .where(eq(nbfcLoanAgreements.agreement_ref, ref))
      .limit(1);
    if (!row) {
      console.warn("[Agreement callback] No agreement for ref:", ref);
      return new NextResponse("No matching agreement", { status: 200 });
    }

    // Verify the handoff signing secret (if configured for this tenant).
    const [cfg] = await db
      .select({ secret: nbfcServiceConfig.esign_webhook_secret })
      .from(nbfcServiceConfig)
      .where(eq(nbfcServiceConfig.tenant_id, row.tenant_id))
      .limit(1);
    if (!verifyInboundSignature(cfg?.secret, raw, req.headers.get("x-itarang-signature"))) {
      return new NextResponse("Invalid signature", { status: 401 });
    }

    const rawStatus = pickStr(body, "status", "canonical_status");
    const canonical = (rawStatus ?? "").toLowerCase();
    const isCanonical = (AGREEMENT_STATES as readonly string[]).includes(canonical);
    const nextStatus: AgreementState = isCanonical ? (canonical as AgreementState) : "in_progress";

    const now = new Date();
    const signedUrl = pickStr(body, "signed_document_url", "signed_url", "document_url");
    const auditUrl = pickStr(body, "audit_trail_url", "audit_url");

    await db
      .update(nbfcLoanAgreements)
      .set({
        status: nextStatus,
        // §17.4 — store the signed doc URL only when the NBFC opted in; the
        // audit-trail pointer is always retained.
        signed_document_url: row.store_loan_agreement ? (signedUrl ?? row.signed_document_url) : row.signed_document_url,
        audit_trail_url: auditUrl ?? row.audit_trail_url,
        provider_raw_status: pickStr(body, "provider_raw_status", "raw_status") ?? rawStatus ?? row.provider_raw_status,
        provider_raw_payload: body as unknown as Record<string, unknown>,
        failure_reason:
          pickStr(body, "failure_reason") ?? (nextStatus === "failed" ? "Reported failed by NBFC" : row.failure_reason),
        signed_at: nextStatus === "signed" ? now : row.signed_at,
        updated_at: now,
      })
      .where(eq(nbfcLoanAgreements.id, row.id));

    return new NextResponse("Accepted", { status: 200 });
  } catch (error) {
    console.error("[Agreement callback] Error:", error);
    // Still 200 so the NBFC integration doesn't retry endlessly.
    return new NextResponse("Internal error logged", { status: 200 });
  }
}

export async function GET(req: NextRequest) {
  const ref = new URL(req.url).searchParams.get("ref");
  return new NextResponse(ref ? `Agreement callback ready for ${ref}` : "Agreement callback endpoint", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
