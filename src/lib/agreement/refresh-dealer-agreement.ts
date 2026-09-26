import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { syncSignersFromDigio } from "@/lib/agreement/sync-signers";
import { mergeProviderRawResponse } from "@/lib/agreement/providerRaw";
import { extractStampCertificateIds } from "@/lib/digio/parse-status";
import { isS3Backend, putObject, filesProxyPath } from "@/lib/storage/s3";

/**
 * Pull the live Digio state of a dealer agreement, sync per-signer rows, cache
 * the signed PDF + audit trail once complete, and persist everything on
 * dealer_onboarding_applications.
 *
 * This used to live inline in the refresh-agreement POST route, so it only
 * ever ran when an admin clicked "Refresh Status". It is now shared so the
 * agreement-tracking GET can run it in the background (source: "auto") and the
 * review page can surface the signed agreement without a click.
 */

type Application = typeof dealerOnboardingApplications.$inferSelect;

export type RefreshDealerAgreementResult =
  | {
      ok: true;
      agreementStatus: string;
      signedAgreementUrl: string | null;
      auditTrailUrl: string | null;
      stampCertificateIds: unknown[];
    }
  | { ok: false; status: number; message: string; raw?: unknown };

type RefreshSource = "manual" | "auto";

// Review states the agreement flow itself owns. While a dealer is
// `under_correction` (request-correction) the correction routes own
// review_status and restore `agreement_completed` themselves; `approved` /
// `rejected` are final. A refresh — especially an automatic one landing
// mid-correction — must never rewind those, so review fields are only
// written when the current value is one of these.
const AGREEMENT_OWNED_REVIEW_STATES = new Set<string | null>([
  null,
  "",
  "pending_admin_review",
  "under_review",
  "agreement_in_progress",
  "agreement_completed",
]);

// Auto-runs are triggered by a ~10 s client poll. Digio's status call is slow
// and intermittently 500s, so without a guard polls stack overlapping calls and
// the completed branch double-downloads the PDF. Manual clicks always run.
const AUTO_MIN_INTERVAL_MS = 5_000;
const runState = new Map<string, { inFlight: boolean; lastRunAt: number }>();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function cleanEnv(value?: string) {
  return value?.trim().replace(/^[\"']|["']$/g, "");
}

function basicAuthHeader(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

function normalizeAgreementStatus(rawStatus?: string | null) {
  const status = String(rawStatus || "").trim().toLowerCase();

  if (["completed", "signed"].includes(status)) return "completed";
  if (["partially_signed", "partial"].includes(status)) return "partially_signed";
  if (["expired"].includes(status)) return "expired";
  if (["failed", "cancelled", "rejected"].includes(status)) return "failed";

  return "sent_for_signature";
}

function extractSigningUrl(parsed: any) {
  const signingParties = Array.isArray(parsed?.signing_parties)
    ? parsed.signing_parties
    : [];

  const dealerParty =
    signingParties.find(
      (party: any) =>
        String(party?.reason || "").toLowerCase() === "dealer signer"
    ) || signingParties[0];

  return (
    dealerParty?.authentication_url ||
    parsed?.signing_url ||
    parsed?.redirect_url ||
    null
  );
}

function extractSignedAgreementUrl(parsed: any) {
  return (
    parsed?.signed_agreement_url ||
    parsed?.executed_file_url ||
    parsed?.file_url ||
    parsed?.download_url ||
    parsed?.document_url ||
    parsed?.agreement?.signed_agreement_url ||
    parsed?.agreement?.executed_file_url ||
    parsed?.agreement?.file_url ||
    parsed?.agreement?.download_url ||
    parsed?.agreement?.document_url ||
    parsed?.data?.signed_agreement_url ||
    parsed?.data?.executed_file_url ||
    parsed?.data?.file_url ||
    parsed?.data?.download_url ||
    parsed?.data?.document_url ||
    parsed?.raw?.signed_agreement_url ||
    parsed?.raw?.executed_file_url ||
    parsed?.raw?.file_url ||
    parsed?.raw?.download_url ||
    parsed?.raw?.document_url ||
    null
  );
}

function extractSignedAt(parsed: any) {
  return parsed?.signed_at || parsed?.completed_at || parsed?.execution_date || null;
}

async function downloadAndCacheFile(url: string, path: string, headers?: Record<string, string>) {
  const response = await fetch(url, {
    method: "GET",
    headers: headers || {},
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Download failed (${response.status}): ${errorText.slice(0, 200)}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const buffer = await response.arrayBuffer();

  // Validate we actually got a PDF, not a JSON error
  if (buffer.byteLength < 100) {
    throw new Error(`Downloaded file too small (${buffer.byteLength} bytes) — likely an error response`);
  }
  if (contentType.includes("json")) {
    const text = new TextDecoder().decode(buffer);
    throw new Error(`Expected PDF but got JSON: ${text.slice(0, 200)}`);
  }

  // Try caching to storage (non-blocking — don't fail if upload fails)
  let publicUrl: string | null = null;
  if (isS3Backend) {
    try {
      await putObject("dealer-documents", path, Buffer.from(buffer), "application/pdf");
      publicUrl = filesProxyPath("dealer-documents", path);
    } catch (cacheErr) {
      console.warn("[REFRESH AGREEMENT] S3 caching error (non-blocking):", cacheErr);
    }
  } else {
    try {
      const { error } = await supabase.storage
        .from("dealer-documents")
        .upload(path, buffer, {
          contentType: "application/pdf",
          upsert: true,
        });

      if (!error) {
        const { data } = supabase.storage.from("dealer-documents").getPublicUrl(path);
        publicUrl = data.publicUrl;
      } else {
        console.warn("[REFRESH AGREEMENT] Supabase cache upload failed (non-blocking):", error.message);
      }
    } catch (cacheErr) {
      console.warn("[REFRESH AGREEMENT] Supabase caching error (non-blocking):", cacheErr);
    }
  }

  return publicUrl;
}

export async function refreshDealerAgreementFromDigio(
  application: Application,
  opts: { source?: RefreshSource } = {},
): Promise<RefreshDealerAgreementResult> {
  const source: RefreshSource = opts.source ?? "manual";
  const dealerId = application.id;

  if (!application.provider_document_id) {
    return { ok: false, status: 400, message: "Agreement not initiated yet." };
  }

  const state = runState.get(dealerId) ?? { inFlight: false, lastRunAt: 0 };
  if (source === "auto") {
    if (state.inFlight) {
      return { ok: false, status: 429, message: "Agreement refresh already running." };
    }
    if (Date.now() - state.lastRunAt < AUTO_MIN_INTERVAL_MS) {
      return { ok: false, status: 429, message: "Agreement refreshed moments ago." };
    }
  }
  state.inFlight = true;
  runState.set(dealerId, state);

  try {
    return await runRefresh(application, source);
  } finally {
    state.inFlight = false;
    state.lastRunAt = Date.now();
    runState.set(dealerId, state);
  }
}

async function runRefresh(
  application: Application,
  source: RefreshSource,
): Promise<RefreshDealerAgreementResult> {
  const dealerId = application.id;
  const tag = source === "auto" ? "[REFRESH AGREEMENT/auto]" : "[REFRESH AGREEMENT]";

  // See the review_status write below — an already-approved dealer is signing
  // their agreement through the post-approval finance-enablement flow, so the
  // review fields must not be rewound.
  const isPostApprovalRun = application.onboarding_status === "approved";

  const clientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
  const clientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
  const baseUrl = cleanEnv(process.env.DIGIO_BASE_URL) || "https://ext.digio.in:444";

  if (!clientId || !clientSecret) {
    return { ok: false, status: 500, message: "Missing Digio credentials" };
  }

  const digioUrl = `${baseUrl}/v2/client/document/${application.provider_document_id}`;

  const digioResponse = await fetch(digioUrl, {
    method: "GET",
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const rawText = await digioResponse.text();

  let parsed: any = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = null;
  }

  if (!digioResponse.ok) {
    return {
      ok: false,
      status: digioResponse.status,
      message:
        parsed?.message ||
        parsed?.error_msg ||
        parsed?.error ||
        "Failed to fetch agreement status from Digio",
      raw: parsed || rawText,
    };
  }

  let normalizedStatus = normalizeAgreementStatus(
    parsed?.agreement_status || parsed?.status
  );
  let aadhaarMismatchReason: string | null = null;

  // Sync per-signer status from Digio's signing_parties array — this is what fixes the
  // "Sent" badge never flipping to "Signed" after a signer completes the agreement.
  try {
    const sync = await syncSignersFromDigio(
      dealerId,
      application.provider_document_id!,
      application.request_id,
      parsed,
    );
    // E-175 — if the dealer signed with an Aadhaar that doesn't match the
    // owner's captured Aadhaar, fail the agreement regardless of what Digio
    // reported (e.g. "completed"), forcing a re-sign with the correct Aadhaar.
    if (sync.dealerAadhaarMismatch) {
      normalizedStatus = "failed";
      aadhaarMismatchReason =
        sync.mismatchReason ?? "Aadhaar mismatch on the dealer signature.";
    }
  } catch (signerSyncErr) {
    console.error(`${tag} signer sync failed (non-blocking):`, signerSyncErr);
  }

  const signingUrl = extractSigningUrl(parsed);
  let signedAgreementUrl =
    extractSignedAgreementUrl(parsed) || application.signed_agreement_url || null;

  let auditTrailUrl = application.audit_trail_url || null;

  const refreshedStampCertificateIds = extractStampCertificateIds(parsed);
  const existingStampCertificateIds = Array.isArray(application.stamp_certificate_ids)
    ? application.stamp_certificate_ids
    : [];
  const mergedStampCertificateIds =
    refreshedStampCertificateIds.length > 0
      ? refreshedStampCertificateIds
      : existingStampCertificateIds;

  console.log(
    `${tag} refreshed stampCertificateIds:`,
    JSON.stringify(refreshedStampCertificateIds),
    "merged:",
    JSON.stringify(mergedStampCertificateIds),
  );

  if (normalizedStatus === "completed") {
    try {
      const signedStoragePath = `agreements/${dealerId}/signed-agreement.pdf`;

      // First preference: use URL from Digio status response
      const extractedSignedUrl = extractSignedAgreementUrl(parsed);

      const digioAuthHeaders = {
        Authorization: basicAuthHeader(clientId, clientSecret),
        Accept: "application/pdf",
      };

      if (extractedSignedUrl && !application.signed_agreement_storage_path) {
        const publicUrl = await downloadAndCacheFile(
          extractedSignedUrl,
          signedStoragePath,
          digioAuthHeaders
        );

        signedAgreementUrl = publicUrl || extractedSignedUrl;

        if (publicUrl) {
          await db
            .update(dealerOnboardingApplications)
            .set({
              signed_agreement_storage_path: signedStoragePath,
              signed_agreement_url: publicUrl,
            })
            .where(eq(dealerOnboardingApplications.id, dealerId));
        }
      } else if (!application.signed_agreement_storage_path) {
        // Fallback: try Digio direct download only if no signed URL available
        const directDownloadUrl = `${baseUrl}/v2/client/document/download?document_id=${application.provider_document_id}`;

        console.log(`${tag} trying Digio direct PDF download:`, directDownloadUrl);

        const directPdfRes = await fetch(directDownloadUrl, {
          method: "GET",
          headers: {
            Authorization: basicAuthHeader(clientId, clientSecret),
            Accept: "application/pdf",
          },
        });

        if (directPdfRes.ok) {
          const buffer = await directPdfRes.arrayBuffer();

          if (isS3Backend) {
            try {
              await putObject("dealer-documents", signedStoragePath, Buffer.from(buffer), "application/pdf");
              signedAgreementUrl = filesProxyPath("dealer-documents", signedStoragePath);

              await db
                .update(dealerOnboardingApplications)
                .set({
                  signed_agreement_storage_path: signedStoragePath,
                  signed_agreement_url: signedAgreementUrl,
                })
                .where(eq(dealerOnboardingApplications.id, dealerId));
            } catch (uploadErr) {
              console.error(`${tag} S3 upload failed:`, uploadErr);
            }
          } else {
            const { error } = await supabase.storage
              .from("dealer-documents")
              .upload(signedStoragePath, buffer, {
                contentType: "application/pdf",
                upsert: true,
              });

            if (!error) {
              const { data } = supabase.storage
                .from("dealer-documents")
                .getPublicUrl(signedStoragePath);

              signedAgreementUrl = data.publicUrl;

              await db
                .update(dealerOnboardingApplications)
                .set({
                  signed_agreement_storage_path: signedStoragePath,
                  signed_agreement_url: signedAgreementUrl,
                })
                .where(eq(dealerOnboardingApplications.id, dealerId));
            } else {
              console.error(`${tag} Supabase upload failed:`, error.message);
            }
          }
        } else {
          const errText = await directPdfRes.text();
          console.error(`${tag} Digio direct download failed:`, directPdfRes.status, errText);
        }
      }

      // Audit trail
      if (!application.audit_trail_storage_path) {
        const auditTrailDigioUrl = `${baseUrl}/v2/client/document/download_audit_trail?document_id=${application.provider_document_id}`;
        const auditPath = `agreements/${dealerId}/audit-trail.pdf`;

        const publicUrl = await downloadAndCacheFile(auditTrailDigioUrl, auditPath, digioAuthHeaders);

        if (publicUrl) {
          auditTrailUrl = publicUrl;

          await db
            .update(dealerOnboardingApplications)
            .set({
              audit_trail_storage_path: auditPath,
              audit_trail_url: publicUrl,
            })
            .where(eq(dealerOnboardingApplications.id, dealerId));
        }
      }
    } catch (err) {
      console.error(`${tag} file upload error:`, err);
    }
  }

  const canTouchReviewFields =
    !isPostApprovalRun &&
    AGREEMENT_OWNED_REVIEW_STATES.has(
      (application.review_status || "").toLowerCase() || null,
    );

  await db
    .update(dealerOnboardingApplications)
    .set({
      agreement_status: normalizedStatus,
      provider_signing_url: signingUrl,
      signed_agreement_url: signedAgreementUrl,
      audit_trail_url: auditTrailUrl,
      provider_raw_response: mergeProviderRawResponse(
        application.provider_raw_response,
        parsed || {},
      ),
      stamp_certificate_ids: mergedStampCertificateIds,
      stamp_status:
        mergedStampCertificateIds.length > 0
          ? "attached"
          : application.stamp_status || null,
      ...(aadhaarMismatchReason
        ? {
            agreement_failure_reason: aadhaarMismatchReason,
            agreement_failed_at: new Date(),
          }
        : {}),
      // Post-approval finance enablement: an already-approved dealer signing
      // their finance agreement must stay "approved" in the review queue —
      // they were reviewed and activated long ago. Only a still-in-review
      // application tracks its review state off the agreement, and only while
      // the agreement flow owns review_status (see AGREEMENT_OWNED_REVIEW_STATES).
      // agreement_status above is the real signal activate-finance gates on
      // either way.
      ...(canTouchReviewFields
        ? {
            completion_status:
              normalizedStatus === "completed" ? "completed" : "pending",
            review_status:
              normalizedStatus === "completed"
                ? "agreement_completed"
                : "agreement_in_progress",
          }
        : {}),
      signed_at:
        normalizedStatus === "completed"
          ? new Date(extractSignedAt(parsed) || new Date())
          : application.signed_at || null,
      last_action_timestamp: new Date(),
      updated_at: new Date(),
    })
    .where(eq(dealerOnboardingApplications.id, dealerId));

  return {
    ok: true,
    agreementStatus: normalizedStatus,
    signedAgreementUrl,
    auditTrailUrl,
    stampCertificateIds: mergedStampCertificateIds,
  };
}
