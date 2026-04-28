import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { extractDigioDocumentId } from "./parse-status";

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
  if (application.auditTrailUrl) return application.auditTrailUrl;
  if (!application.providerDocumentId) return null;

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
        application.providerDocumentId
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
      if (remoteId && remoteId !== application.providerDocumentId) {
        console.warn(
          "[ensureDealerAuditTrailUrl] DigiO document_id mismatch",
          {
            applicationId: application.id,
            expected: application.providerDocumentId,
            digioReturned: remoteId,
          }
        );
      }
    }
  } catch (err) {
    console.warn("[ensureDealerAuditTrailUrl] status pre-check failed (non-blocking):", err);
  }

  const digioUrl = `${baseUrl}/v2/client/document/download_audit_trail?document_id=${encodeURIComponent(
    application.providerDocumentId
  )}`;

  const response = await fetch(digioUrl, {
    method: "GET",
    headers: {
      Authorization: authHeader,
      Accept: "application/pdf",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.warn("[ensureDealerAuditTrailUrl] download non-ok", {
      documentId: application.providerDocumentId,
      url: digioUrl,
      status: response.status,
      body: body.slice(0, 500),
    });
    return null;
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("json")) {
    const body = await response.text().catch(() => "");
    console.warn("[ensureDealerAuditTrailUrl] download returned JSON", {
      contentType,
      body: body.slice(0, 500),
    });
    return null;
  }

  const pdfBuffer = await response.arrayBuffer();
  if (pdfBuffer.byteLength < 100) {
    console.warn("[ensureDealerAuditTrailUrl] pdf buffer too small / empty", {
      byteLength: pdfBuffer.byteLength,
    });
    return null;
  }

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
      auditTrailUrl,
      auditTrailStoragePath: filePath,
      updatedAt: new Date(),
    })
    .where(eq(dealerOnboardingApplications.id, application.id));

  return auditTrailUrl;
}
