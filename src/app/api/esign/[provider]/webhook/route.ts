/**
 * POST /api/esign/[provider]/webhook  (E-166)
 *
 * Result callback for an NBFC's OWN e-sign provider (their own Digio account,
 * Leegality, …). The provider's adapter parses the raw event into the canonical
 * status; the SHARED forward-only state machine applies it to nbfc_loan_agreements.
 * The signed-PDF fetch (when storage is opted in) uses the NBFC's own credentials.
 *
 * Public — matched by the opaque agreement_ref / provider document id. A
 * genuine event always gets a 200-ish answer so the provider doesn't retry.
 *
 * Who is calling (tracker ID 118): the proof is the PROVIDER's own signing, with
 * the secret of whichever account created the document — so it is checked after
 * the agreement is matched, against that NBFC's stored webhook secret:
 *   - digio      X-Digio-Checksum (HMAC-SHA256 of the body). The NBFC saves its
 *                Digio webhook secret key next to its API keys in Settings.
 *   - leegality  `mac` in the body = HMAC-SHA1(documentId, Private Salt). The
 *                NBFC saves its Private Salt next to its auth token (ID 130).
 * Until a secret is saved the event is accepted as before and logged; under
 * WEBHOOK_AUTH_STRICT=1 it is refused.
 */
import { NextRequest, NextResponse } from "next/server";

import { applyAgreementWebhookEvent } from "@/lib/nbfc/agreement-webhook";
import { getEsignProvider, isKnownEsignProvider } from "@/lib/nbfc/esign/registry";
import { loadProviderCredentials } from "@/lib/nbfc/esign/credentials";
import type { EsignCreds } from "@/lib/nbfc/esign/provider";
import { checkWebhook, checksumProof, leegalityMacProof, type WebhookProof } from "@/lib/security/webhookAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The secret that signs this provider's webhooks for the account that owns the document. */
function webhookSecretFor(provider: string, creds: EsignCreds | null): string | undefined {
  if (provider === "leegality") return creds?.secrets.privateSalt || undefined;
  if (provider !== "digio") return undefined;
  // No vault row ⇒ the document was created on iTarang's own Digio account.
  if (!creds || creds.source === "global") return process.env.DIGIO_WEBHOOK_SECRET;
  return creds.secrets.webhookSecret || undefined;
}

function proofFor(provider: string, secret: string | undefined, rawText: string, headers: Record<string, string>): WebhookProof {
  if (provider === "leegality") return leegalityMacProof(secret, rawText);
  return checksumProof(secret, rawText, headers["x-digio-checksum"]);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isKnownEsignProvider(provider)) {
    return NextResponse.json({ ok: false, error: "unknown provider" }, { status: 404 });
  }

  let rawText = "";
  try {
    rawText = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });

  const adapter = await getEsignProvider(provider);
  const parsed = await adapter.parseWebhookStatus(rawText, headers);
  if (!parsed || (!parsed.matchRef && !parsed.providerDocumentId)) {
    return NextResponse.json({ ok: false, error: "VALIDATION" }, { status: 400 });
  }

  const result = await applyAgreementWebhookEvent(
    parsed,
    async (row) => {
      const creds = await loadProviderCredentials(row.tenant_id, row.provider_type ?? provider);
      if (!creds) return { signedPdfUrl: null, auditTrailUrl: null };
      return adapter.fetchSignedDocuments(
        { leadId: row.lead_id, providerDocumentId: row.digio_document_id ?? parsed.providerDocumentId ?? "" },
        creds,
      );
    },
    async (row) => {
      const creds = await loadProviderCredentials(row.tenant_id, row.provider_type ?? provider);
      const secret = webhookSecretFor(provider, creds);
      const verdict = checkWebhook({
        route: `/api/esign/${provider}/webhook`,
        secret,
        proof: proofFor(provider, secret, rawText, headers),
        configure:
          provider === "digio"
            ? "The NBFC must save its Digio webhook secret key in Settings → e-sign credentials."
            : provider === "leegality"
              ? "The NBFC must save its Leegality Private Salt in Settings → e-sign credentials."
              : `No webhook verification is implemented for ${provider} yet.`,
      });
      return verdict !== "refuse";
    },
  );

  if (result.unauthorized) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!result.matched) {
    return NextResponse.json({ ok: true, idempotent: true, reason: result.reason });
  }
  return NextResponse.json({
    ok: true,
    agreement_ref: result.agreementRef,
    status: result.status,
    idempotent: result.idempotent ?? false,
    stored_pdf: result.storedPdf ?? false,
  });
}
