import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";

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
    return null;
  }

  const digioUrl = `${baseUrl}/v2/client/document/download_audit_trail?document_id=${encodeURIComponent(
    application.providerDocumentId
  )}`;

  const response = await fetch(digioUrl, {
    method: "GET",
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      Accept: "application/pdf",
    },
    cache: "no-store",
  });

  if (!response.ok) return null;

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("json")) return null;

  const pdfBuffer = await response.arrayBuffer();
  if (pdfBuffer.byteLength < 100) return null;

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
