export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { launchBrowser } from "@/lib/pdf/launch-browser";
import { db } from "@/lib/db";
import {
  dealerAgreementEvents,
  dealerAgreementSigners,
  dealerOnboardingApplications,
} from "@/lib/db/schema";
import { asc, desc, eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import {
  downloadDigioAuditTrail,
  fetchDigioAuditLogJson,
  fetchDigioDocumentStatus,
} from "@/lib/digio";
import {
  buildAuditTrailHtml,
  type AuditSignerDetail,
} from "@/lib/agreement/audit-trail-template";
import { requireAdmin } from "@/lib/auth/requireAdmin";

function pickString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function normalizeEmail(value?: string | null): string {
  return (value || "").trim().toLowerCase();
}

/**
 * Digio's document-status response has a `signing_parties` array. Each item carries
 * the real per-signer audit metadata (IP, browser, ESP, ASP ID, hashes, signed time,
 * Aadhaar name for eSign). We key these by email (falling back to identifier) and
 * merge them into our local signer rows.
 */
type DigioSigningPartyMap = Map<string, any>;

function buildSigningPartyMap(status: Record<string, unknown> | null): DigioSigningPartyMap {
  const map: DigioSigningPartyMap = new Map();
  if (!status) return map;

  const parties = Array.isArray((status as any).signing_parties)
    ? ((status as any).signing_parties as any[])
    : Array.isArray((status as any).signingParties)
      ? ((status as any).signingParties as any[])
      : [];

  for (const p of parties) {
    const email = normalizeEmail(
      p?.email || p?.signer_email || p?.identifier || p?.signerIdentifier
    );
    if (email) map.set(email, p);

    const reason = String(p?.reason || "").toLowerCase();
    if (reason) map.set(`reason:${reason}`, p);
  }

  return map;
}

function extractBrowserParts(party: any): {
  browserName?: string;
  browserVersion?: string;
  osName?: string;
  osVersion?: string;
  device?: string;
} {
  const browser = party?.browser_details || party?.browserDetails || party?.browser || {};
  return {
    browserName: pickString(browser?.name, browser?.browser_name, browser?.browserName) || undefined,
    browserVersion:
      pickString(browser?.version, browser?.browser_version, browser?.browserVersion) || undefined,
    osName: pickString(browser?.os, browser?.os_name, browser?.osName) || undefined,
    osVersion: pickString(browser?.os_version, browser?.osVersion) || undefined,
    device: pickString(browser?.device, browser?.device_name) || undefined,
  };
}

function mergeSigner(
  seq: number,
  localSigner: typeof dealerAgreementSigners.$inferSelect,
  partyMap: DigioSigningPartyMap,
  invitationAt: Date | null,
): AuditSignerDetail {
  const email = normalizeEmail(localSigner.signerEmail);
  // Map local signer roles to the `reason` strings Digio parties carry
  // (see initiate-agreement/route.ts). Previously this only built a key for
  // `dealer`, so iTarang / financier audit data never matched.
  const role = (localSigner.signerRole || "").toLowerCase().trim();
  const REASON_BY_ROLE: Record<string, string> = {
    dealer: "dealer signer",
    itarang_signatory_1: "itarang signer 1",
    itarang_signatory_2: "itarang signer 2",
    financier: "financier signer",
  };
  const reasonToken = REASON_BY_ROLE[role] || (role ? `${role.replace(/_/g, " ")} signer` : "");
  const reasonKey = reasonToken ? `reason:${reasonToken}` : "";
  const party =
    (email ? partyMap.get(email) : null) ||
    (reasonKey ? partyMap.get(reasonKey) : null) ||
    (localSigner.providerRawResponse as any) ||
    null;

  const browser = extractBrowserParts(party);
  const status = pickString(party?.status, localSigner.signerStatus) || undefined;
  const signingMethod = pickString(party?.sign_type, localSigner.signingMethod) || undefined;

  return {
    sequence: seq,
    displayName: pickString(party?.name, localSigner.signerName) || "Signer",
    email: pickString(party?.email, localSigner.signerEmail) || undefined,
    mobile: pickString(party?.mobile, localSigner.signerMobile) || undefined,
    requestedAt:
      pickString(party?.requested_on, party?.requested_at, party?.invited_on) ||
      (invitationAt ? invitationAt.toISOString() : null) ||
      localSigner.createdAt?.toISOString() ||
      null,
    signedAt:
      pickString(party?.signed_on, party?.signed_at) ||
      (localSigner.signedAt ? localSigner.signedAt.toISOString() : null),
    ip: pickString(party?.ip_address, party?.ip) || undefined,
    esp: pickString(party?.esp, party?.esp_name) || undefined,
    aspId: pickString(party?.asp_id, party?.aspId) || undefined,
    ...browser,
    certifiedName: pickString(party?.certified_name, party?.aadhaar_name, party?.kyc_name) || undefined,
    activity:
      pickString(party?.activity) ||
      (signingMethod?.toLowerCase().includes("aadhaar") ? "Aadhaar Otp Signing" : "Electronic Signing"),
    documentHash: pickString(party?.document_hash, party?.documentHash) || undefined,
    photoHash: pickString(party?.photo_hash, party?.photoHash) || undefined,
    signingMethod,
    status,
  };
}

async function renderAuditTrailPdf(
  application: typeof dealerOnboardingApplications.$inferSelect
): Promise<Buffer> {
  const [localSigners, events] = await Promise.all([
    db
      .select()
      .from(dealerAgreementSigners)
      .where(eq(dealerAgreementSigners.applicationId, application.id))
      .orderBy(asc(dealerAgreementSigners.createdAt)),
    db
      .select()
      .from(dealerAgreementEvents)
      .where(eq(dealerAgreementEvents.applicationId, application.id))
      .orderBy(desc(dealerAgreementEvents.createdAt)),
  ]);

  // Try to fetch Digio document status + audit_log JSON to enrich per-signer details
  // (IP, browser, ESP, ASP ID, document hash, photo hash, certified name, etc.)
  let digioStatus: Record<string, unknown> | null = null;
  let digioAuditLog: Record<string, unknown> | null = null;
  if (application.providerDocumentId) {
    const [statusResult, auditResult] = await Promise.allSettled([
      fetchDigioDocumentStatus(application.providerDocumentId),
      fetchDigioAuditLogJson(application.providerDocumentId),
    ]);
    digioStatus = statusResult.status === "fulfilled" ? statusResult.value : null;
    digioAuditLog = auditResult.status === "fulfilled" ? auditResult.value : null;
  }

  // Merge audit_log signer entries into the party map so mergeSigner() picks them up
  const partyMap = buildSigningPartyMap(digioStatus);
  if (digioAuditLog) {
    const auditParties =
      (digioAuditLog as any).signing_parties ||
      (digioAuditLog as any).signers ||
      (digioAuditLog as any).audit_log ||
      (digioAuditLog as any).audit_logs ||
      (digioAuditLog as any).parties ||
      [];
    if (Array.isArray(auditParties)) {
      for (const entry of auditParties) {
        const email = normalizeEmail(
          entry?.email || entry?.signer_email || entry?.identifier,
        );
        if (email) {
          // Audit log entries take precedence — they have the richest per-signer audit data
          partyMap.set(email, { ...(partyMap.get(email) || {}), ...entry });
        }
      }
    }
  }

  const invitationEvent = events.find((e) =>
    ["initiated", "created", "sent"].includes(String(e.eventType || "").toLowerCase()),
  );
  const invitationAt = invitationEvent?.createdAt || application.createdAt || null;

  const completedEvent = events.find((e) =>
    ["completed", "signing_complete", "signed"].includes(
      String(e.eventType || "").toLowerCase(),
    ),
  );
  const digioCompletedAt = pickString(
    (digioStatus as any)?.completed_on,
    (digioStatus as any)?.signed_on,
  );

  let signers: AuditSignerDetail[];
  if (localSigners.length === 0) {
    // No DB-backed signer rows (e.g. rows not yet written, or cleared). Fall back to
    // synthesizing minimal signer-like objects from the Digio party map so the audit
    // PDF still renders per-signer entries instead of an empty table.
    const syntheticEntries = Array.from(partyMap.entries()).filter(
      ([key]) => !key.startsWith("reason:"),
    );
    signers = syntheticEntries.map(([email, party], i) => {
      const synthetic = {
        signerEmail: pickString(party?.email, email),
        signerName: pickString(party?.name, party?.signer_name, party?.displayName),
        signerMobile: pickString(party?.mobile, party?.phone),
        signerRole: pickString(party?.reason, party?.role),
        signerStatus: pickString(party?.status),
        signingMethod: pickString(party?.sign_type),
        signedAt: null,
        createdAt: null,
        providerRawResponse: party,
        providerDocumentId: application.providerDocumentId,
      } as unknown as typeof dealerAgreementSigners.$inferSelect;
      return mergeSigner(i + 1, synthetic, partyMap, invitationAt);
    });
  } else {
    signers = localSigners.map((s, i) => mergeSigner(i + 1, s, partyMap, invitationAt));
  }

  const invitationIp = pickString(
    (digioStatus as any)?.owner_ip,
    (digioStatus as any)?.created_ip,
    (digioStatus as any)?.request_ip,
    (digioStatus as any)?.ip,
    (invitationEvent?.eventPayload as any)?.ip,
  );

  const documentName = pickString(
    (digioStatus as any)?.file_name,
    application.companyName ? `${application.companyName}-agreement.pdf` : null,
  ) || "agreement.pdf";

  const ownerName = pickString(
    (digioStatus as any)?.owner_name,
    (digioStatus as any)?.ownerName,
  ) || "ITARANG TECHNOLOGIES LLP";

  const ownerEmail = pickString(
    (digioStatus as any)?.owner_email,
    (digioStatus as any)?.ownerEmail,
    process.env.DIGIO_OWNER_EMAIL,
  ) || "it@itarang.com";

  const status = pickString(
    (digioStatus as any)?.agreement_status,
    (digioStatus as any)?.status,
    application.agreementStatus,
  ) || "completed";

  const html = buildAuditTrailHtml({
    documentName,
    documentId: application.providerDocumentId || application.id,
    status,
    ownerName,
    ownerEmail,
    invitationIp: invitationIp || undefined,
    signers,
    completedAt:
      digioCompletedAt ||
      completedEvent?.createdAt?.toISOString() ||
      application.signedAt?.toISOString() ||
      null,
    completionEmails: signers
      .map((s) => s.email)
      .filter((e): e is string => !!e),
    generatedAt: new Date(),
  });

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", right: "12mm", bottom: "14mm", left: "12mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};


function cleanEnv(value?: string) {
  return value?.trim().replace(/^[\"']|[\"']$/g, "");
}

function isValidPdfBuffer(buffer: ArrayBuffer | null | undefined): buffer is ArrayBuffer {
  if (!buffer || buffer.byteLength < 500) return false;
  const head = new Uint8Array(buffer, 0, 5);
  return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d;
}

export async function GET(_req: NextRequest, context: RouteContext) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;

    const applicationRows = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    const application = applicationRows[0];

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Dealer application not found" },
        { status: 404 }
      );
    }

    const documentId = application.providerDocumentId || null;

    if (!documentId) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Digio document ID not found. Agreement may not be created yet.",
        },
        { status: 400 }
      );
    }

    const supabaseUrl = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
    const serviceRoleKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json(
        { success: false, message: "Missing Supabase configuration" },
        { status: 500 }
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const bucketName = "dealer-documents";
    const filePath =
      application.auditTrailStoragePath ||
      `agreements/${dealerId}/audit-trail.pdf`;

    let fileBuffer: ArrayBuffer | null = null;

    // 1. Try existing Supabase stored file first
    if (application.auditTrailStoragePath) {
      const { data, error } = await supabase.storage
        .from(bucketName)
        .download(application.auditTrailStoragePath);

      if (!error && data) {
        const candidate = await data.arrayBuffer();
        if (isValidPdfBuffer(candidate)) {
          fileBuffer = candidate;
        } else {
          console.warn(
            "[AUDIT TRAIL DOWNLOAD] Supabase cache invalid (size=",
            candidate.byteLength,
            "), will re-fetch from Digio"
          );
        }
      } else {
        console.error(
          "[AUDIT TRAIL DOWNLOAD] Supabase stored file download failed:",
          error?.message
        );
      }
    }

    // 2. If not already stored, generate locally using Digio's audit_log JSON as the
    //    primary path (Digio's /audit_log endpoint returns JSON, not a PDF — we render
    //    the PDF here via Puppeteer). Fall back to the /download_audit_trail PDF variants
    //    only if local rendering fails.
    let effectiveContentType = "application/pdf";

    if (!fileBuffer) {
      // Primary: fetch Digio audit_log JSON + document status, render PDF via Puppeteer.
      try {
        const generatedPdf = await renderAuditTrailPdf(application);
        const candidate = await new Response(generatedPdf).arrayBuffer();

        if (isValidPdfBuffer(candidate)) {
          fileBuffer = candidate;
          console.log(
            "[AUDIT TRAIL] Generated local audit trail PDF from Digio audit_log JSON, size=",
            fileBuffer.byteLength
          );
        } else {
          console.warn("[AUDIT TRAIL] Local PDF generator returned invalid buffer — falling back to Digio direct-download.");
        }
      } catch (renderErr: any) {
        console.warn(
          "[AUDIT TRAIL] Local PDF generation failed — falling back to Digio direct-download.",
          renderErr?.message
        );
      }

      // Fallback: try Digio's direct-download PDF endpoints (rarely works, but kept for safety).
      if (!fileBuffer) {
        try {
          const { buffer, contentType } = await downloadDigioAuditTrail(documentId, {
            alternateIds: [application.requestId],
          });

          const candidate =
            buffer instanceof ArrayBuffer ? buffer : await new Response(buffer).arrayBuffer();

          if (
            (contentType?.includes("pdf") || contentType?.includes("octet-stream")) &&
            isValidPdfBuffer(candidate)
          ) {
            fileBuffer = candidate;
            effectiveContentType = contentType || "application/pdf";
          }
        } catch (digioErr: any) {
          // entityNotFound means Digio doesn't have the document — surface
          // that to the outer catch so it can return a 404 + auditTrailAvailable:false
          // instead of the generic 500 below. Other errors stay suppressed so
          // we can still fall back to Puppeteer-generated PDF.
          if (digioErr?.entityNotFound) {
            console.warn("[AUDIT TRAIL] Digio direct-download: ENTITY_NOT_FOUND");
            throw digioErr;
          }
          console.warn(
            "[AUDIT TRAIL] Digio direct-download also failed.",
            digioErr?.message
          );
        }
      }

      if (!fileBuffer) {
        return NextResponse.json(
          { success: false, message: "Failed to generate audit trail PDF." },
          { status: 500 }
        );
      }

      // Try to cache in Supabase storage for future downloads (non-blocking)
      try {
        const { error: uploadError } = await supabase.storage
          .from(bucketName)
          .upload(filePath, fileBuffer, {
            contentType: effectiveContentType,
            upsert: true,
          });

        if (!uploadError) {
          const { data: publicUrlData } = supabase.storage
            .from(bucketName)
            .getPublicUrl(filePath);

          const auditTrailUrl = publicUrlData?.publicUrl;

          if (auditTrailUrl) {
            await db
              .update(dealerOnboardingApplications)
              .set({
                auditTrailUrl,
                auditTrailStoragePath: filePath,
                updatedAt: new Date(),
              })
              .where(eq(dealerOnboardingApplications.id, dealerId));
          }
        } else {
          console.warn("[AUDIT TRAIL] Supabase cache upload failed (non-blocking):", uploadError.message);
        }
      } catch (cacheErr) {
        console.warn("[AUDIT TRAIL] Supabase caching error (non-blocking):", cacheErr);
      }
    }

    if (!fileBuffer) {
      return NextResponse.json(
        {
          success: false,
          message: "Audit trail file could not be prepared",
        },
        { status: 500 }
      );
    }

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="audit-trail-${dealerId}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: any) {
    console.error("[DIGIO_AUDIT_TRAIL_DOWNLOAD_ERROR]", error);

    const isEntityNotFound = error?.entityNotFound === true;

    return NextResponse.json(
      {
        success: false,
        auditTrailAvailable: !isEntityNotFound,
        message:
          error instanceof Error
            ? error.message
            : "Failed to download audit trail",
      },
      { status: isEntityNotFound ? 404 : 500 }
    );
  }
}