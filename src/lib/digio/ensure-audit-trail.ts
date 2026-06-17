import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { extractDigioDocumentId } from "./parse-status";
import { fetchDigioPdfWithRetry } from "./fetch-pdf-retry";

type Application = typeof dealerOnboardingApplications.$inferSelect;

function cleanEnv(value?: string) {
  return value?.trim().replace(/^["']|["']$/g, "");
}

function basicAuthHeader(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

/**
 * Ensure the dealer's DigiO audit trail PDF is cached in Supabase and return
 * its public URL. Returns the existing URL if already cached, fetches from
 * DigiO and uploads to Supabase otherwise. Returns null if prerequisites
 * (providerDocumentId / credentials) are missing or the fetch fails.
 */
export async function ensureDealerAuditTrailUrl(
  application: Application
): Promise<string | null> {
  if (application.audit_trail_url) return application.audit_trail_url;
  if (!application.provider_document_id) return null;

  const clientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
  const clientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
  const baseUrl =
    cleanEnv(process.env.DIGIO_BASE_URL) || "https://ext.digio.in:444";
  const supabaseUrl = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!clientId || !clientSecret || !supabaseUrl || !serviceRoleKey) {
    console.warn("[ensureDealerAuditTrailUrl] missing env vars", {
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(clientSecret),
      hasSupabaseUrl: Boolean(supabaseUrl),
      hasServiceRoleKey: Boolean(serviceRoleKey),
    });
    return null;
  }

  const authHeader = basicAuthHeader(clientId, clientSecret);

  // Cross-contamination breadcrumb: verify DigiO's status response echoes the
  // same document_id we're about to request an audit trail for. A mismatch
  // means the providerDocumentId on this application row is stale / wrong —
  // log it loudly but don't hard-block, since DigiO response shapes vary.
  try {
    const statusRes = await fetch(
      `${baseUrl}/v2/client/document/${encodeURIComponent(
        application.provider_document_id
      )}`,
      {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
        cache: "no-store",
      }
    );

    if (statusRes.ok) {
      const parsed = await statusRes.json().catch(() => null);
      const remoteId = extractDigioDocumentId(parsed);
      if (remoteId && remoteId !== application.provider_document_id) {
        console.warn(
          "[ensureDealerAuditTrailUrl] DigiO document_id mismatch",
          {
            applicationId: application.id,
            expected: application.provider_document_id,
            digioReturned: remoteId,
          }
        );
      }
    }
  } catch (err) {
    console.warn("[ensureDealerAuditTrailUrl] status pre-check failed (non-blocking):", err);
  }

  const digioUrl = `${baseUrl}/v2/client/document/download_audit_trail?document_id=${encodeURIComponent(
    application.provider_document_id
  )}`;

  // DigiO's download_audit_trail intermittently returns HTTP 500 SYSTEM_ERROR
  // even when the agreement is "completed" — retry a few times to catch a
  // working window before giving up.
  const pdfBuffer = await fetchDigioPdfWithRetry(digioUrl, authHeader, {
    label: "ensureDealerAuditTrailUrl",
  });
  if (!pdfBuffer) return null;

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const bucketName = "dealer-documents";
  const filePath = `agreements/${application.id}/audit-trail.pdf`;

  const { error: uploadError } = await supabase.storage
    .from(bucketName)
    .upload(filePath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError) return null;

  const { data: publicUrlData } = supabase.storage
    .from(bucketName)
    .getPublicUrl(filePath);

  const auditTrailUrl = publicUrlData?.publicUrl;
  if (!auditTrailUrl) return null;

  await db
    .update(dealerOnboardingApplications)
    .set({
      audit_trail_url: auditTrailUrl,
      audit_trail_storage_path: filePath,
      updated_at: new Date(),
    })
    .where(eq(dealerOnboardingApplications.id, application.id));

  return auditTrailUrl;
}
