import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { extractSignedAgreementUrl } from "./parse-status";
import { fetchDigioPdfWithRetry } from "./fetch-pdf-retry";
import { isS3Backend, putObject, getObject, filesProxyPath } from "@/lib/storage/s3";

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
  // A cached URL is only trustworthy if the object it points at is actually
  // retrievable. On the S3 backend a cached files-proxy URL can point at an
  // object that was never persisted (an earlier store failed, the key was
  // wrong, etc.). When that happens, dealer approval fails forever with
  // "Signed agreement is not ready yet" even though the agreement is fully
  // signed — because downloadPdfBuffer() reads S3, gets NoSuchKey, and returns
  // null. The "Download Signed Agreement" button doesn't hit this because it
  // falls back to a live Digio download. So: verify the S3 object exists before
  // trusting the cached URL; if it's missing, fall through and re-fetch from
  // Digio below (which re-stores it), exactly like the download route does.
  if (application.signed_agreement_url) {
    if (!isS3Backend) return application.signed_agreement_url;

    const cachedPath =
      application.signed_agreement_storage_path ||
      `agreements/${application.id}/signed-agreement.pdf`;
    try {
      const existing = await getObject("dealer-documents", cachedPath);
      if (existing && existing.byteLength >= 100) {
        return application.signed_agreement_url;
      }
      console.warn(
        "[ensureDealerSignedAgreementUrl] cached URL present but S3 object missing/too small — re-fetching from Digio",
        { applicationId: application.id, cachedPath }
      );
    } catch (err) {
      console.warn(
        "[ensureDealerSignedAgreementUrl] S3 existence check failed — re-fetching from Digio",
        err
      );
    }
    // Fall through to the Digio re-fetch when we can; otherwise the cached URL
    // is the best (broken) answer we have.
    if (!application.provider_document_id) return application.signed_agreement_url;
  }
  if (!application.provider_document_id) return null;

  const clientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
  const clientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
  const baseUrl =
    cleanEnv(process.env.DIGIO_BASE_URL) || "https://ext.digio.in:444";
  const supabaseUrl = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!clientId || !clientSecret || (!isS3Backend && (!supabaseUrl || !serviceRoleKey))) {
    console.warn("[ensureDealerSignedAgreementUrl] missing env vars", {
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(clientSecret),
      hasSupabaseUrl: Boolean(supabaseUrl),
      hasServiceRoleKey: Boolean(serviceRoleKey),
    });
    return null;
  }

  const authHeader = basicAuthHeader(clientId, clientSecret);

  // DigiO exposes the signed PDF via two endpoints depending on the document
  // state; try status first so we can extract a signed_agreement_url when
  // present, then fall back to the binary download endpoint.
  const statusUrl = `${baseUrl}/v2/client/document/${encodeURIComponent(
    application.provider_document_id
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

    if (!statusRes.ok) {
      const body = await statusRes.text().catch(() => "");
      console.warn("[ensureDealerSignedAgreementUrl] status endpoint non-ok", {
        documentId: application.provider_document_id,
        url: statusUrl,
        status: statusRes.status,
        body: body.slice(0, 500),
      });
    } else {
      const parsed = await statusRes.json().catch(() => null);
      const signedUrl = extractSignedAgreementUrl(parsed);
      console.log("[ensureDealerSignedAgreementUrl] status response", {
        documentId: application.provider_document_id,
        agreementStatus: parsed?.agreement_status ?? parsed?.status ?? null,
        signedUrlFound: Boolean(signedUrl),
      });

      if (signedUrl) {
        const signedRes = await fetch(signedUrl, {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/pdf",
          },
          cache: "no-store",
        });

        if (!signedRes.ok) {
          console.warn(
            "[ensureDealerSignedAgreementUrl] signedUrl fetch non-ok",
            { signedUrl, status: signedRes.status }
          );
        } else {
          const contentType = signedRes.headers.get("content-type") || "";
          if (contentType.includes("json")) {
            const body = await signedRes.text().catch(() => "");
            console.warn(
              "[ensureDealerSignedAgreementUrl] signedUrl returned JSON",
              { contentType, body: body.slice(0, 500) }
            );
          } else {
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
      application.provider_document_id
    )}`;

    // DigiO's download endpoint intermittently returns HTTP 500 SYSTEM_ERROR
    // even on a "completed" document — retry to catch a working window.
    pdfBuffer = await fetchDigioPdfWithRetry(directUrl, authHeader, {
      label: "ensureDealerSignedAgreementUrl",
    });
    if (!pdfBuffer) return null;
  }

  if (!pdfBuffer || pdfBuffer.byteLength < 100) {
    console.warn(
      "[ensureDealerSignedAgreementUrl] pdf buffer too small / empty",
      { byteLength: pdfBuffer?.byteLength ?? 0 }
    );
    return null;
  }

  const bucketName = "dealer-documents";
  const filePath = `agreements/${application.id}/signed-agreement.pdf`;

  let signedAgreementUrl: string | undefined;

  if (isS3Backend) {
    try {
      await putObject(bucketName, filePath, Buffer.from(pdfBuffer), "application/pdf");
    } catch (uploadErr) {
      console.error("[ensureDealerSignedAgreementUrl] S3 upload failed:", uploadErr);
      return null;
    }
    signedAgreementUrl = filesProxyPath(bucketName, filePath);
  } else {
    const supabase = createClient(supabaseUrl!, serviceRoleKey!);

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

    signedAgreementUrl = publicUrlData?.publicUrl;
  }

  if (!signedAgreementUrl) return null;

  await db
    .update(dealerOnboardingApplications)
    .set({
      signed_agreement_url: signedAgreementUrl,
      signed_agreement_storage_path: filePath,
      updated_at: new Date(),
    })
    .where(eq(dealerOnboardingApplications.id, application.id));

  return signedAgreementUrl;
}
