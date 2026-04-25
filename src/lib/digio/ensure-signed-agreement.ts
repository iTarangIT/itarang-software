import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { extractSignedAgreementUrl } from "./parse-status";

type Application = typeof dealerOnboardingApplications.$inferSelect;

function cleanEnv(value?: string) {
  return value?.trim().replace(/^["']|["']$/g, "");
}

function basicAuthHeader(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

/**
 * Ensure the dealer's signed DigiO agreement PDF is cached in Supabase and
 * return its public URL. Fetches DigiO status + PDF when the cache is cold.
 * Returns null only on genuine failure (missing creds, DigiO error, not ready).
 *
 * Storage path is keyed by application.id — never by DigiO's providerDocumentId
 * — so there is no cross-application contamination.
 */
export async function ensureDealerSignedAgreementUrl(
  application: Application
): Promise<string | null> {
  if (application.signedAgreementUrl) return application.signedAgreementUrl;
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

  const authHeader = basicAuthHeader(clientId, clientSecret);

  // DigiO exposes the signed PDF via two endpoints depending on the document
  // state; try status first so we can extract a signed_agreement_url when
  // present, then fall back to the binary download endpoint.
  const statusUrl = `${baseUrl}/v2/client/document/${encodeURIComponent(
    application.providerDocumentId
  )}`;

  let pdfBuffer: ArrayBuffer | null = null;

  try {
    const statusRes = await fetch(statusUrl, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (statusRes.ok) {
      const parsed = await statusRes.json().catch(() => null);
      const signedUrl = extractSignedAgreementUrl(parsed);

      if (signedUrl) {
        const signedRes = await fetch(signedUrl, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/pdf",
          },
          cache: "no-store",
        });

        if (signedRes.ok) {
          const contentType = signedRes.headers.get("content-type") || "";
          if (!contentType.includes("json")) {
            pdfBuffer = await signedRes.arrayBuffer();
          }
        }
      }
    }
  } catch (err) {
    console.error("[ensureDealerSignedAgreementUrl] status fetch failed:", err);
  }

  if (!pdfBuffer || pdfBuffer.byteLength < 100) {
    const directUrl = `${baseUrl}/v2/client/document/download?document_id=${encodeURIComponent(
      application.providerDocumentId
    )}`;

    try {
      const directRes = await fetch(directUrl, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/pdf",
        },
        cache: "no-store",
      });

      if (!directRes.ok) return null;

      const contentType = directRes.headers.get("content-type") || "";
      if (contentType.includes("json")) return null;

      pdfBuffer = await directRes.arrayBuffer();
    } catch (err) {
      console.error("[ensureDealerSignedAgreementUrl] direct fetch failed:", err);
      return null;
    }
  }

  if (!pdfBuffer || pdfBuffer.byteLength < 100) return null;

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const bucketName = "dealer-documents";
  const filePath = `agreements/${application.id}/signed-agreement.pdf`;

  const { error: uploadError } = await supabase.storage
    .from(bucketName)
    .upload(filePath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError) {
    console.error(
      "[ensureDealerSignedAgreementUrl] supabase upload failed:",
      uploadError.message
    );
    return null;
  }

  const { data: publicUrlData } = supabase.storage
    .from(bucketName)
    .getPublicUrl(filePath);

  const signedAgreementUrl = publicUrlData?.publicUrl;
  if (!signedAgreementUrl) return null;

  await db
    .update(dealerOnboardingApplications)
    .set({
      signedAgreementUrl,
      signedAgreementStoragePath: filePath,
      updatedAt: new Date(),
    })
    .where(eq(dealerOnboardingApplications.id, application.id));

  return signedAgreementUrl;
}
