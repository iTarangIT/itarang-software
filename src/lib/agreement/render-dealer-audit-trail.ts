// The dealer agreement's audit-trail PDF, rendered by us from Digio's
// audit_log JSON + document status and our own signer / event rows (Digio's
// download_audit_trail endpoint answers ENTITY_NOT_FOUND for these documents).
// Shared by the "Download Audit Trail" button (audit-trail route) and
// ensureDealerAuditTrailUrl, so Approve & Activate attaches the same PDF the
// button produces without anyone clicking it first.

import { launchBrowser } from "@/lib/pdf/launch-browser";
import { db } from "@/lib/db";
import {
  dealerAgreementEvents,
  dealerAgreementSigners,
  dealerOnboardingApplications,
} from "@/lib/db/schema";
import { asc, desc, eq } from "drizzle-orm";
import { fetchDigioAuditLogJson, fetchDigioDocumentStatus } from "@/lib/digio";
import { buildAuditTrailHtml, type AuditSignerDetail } from "@/lib/agreement/audit-trail-template";

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
  const email = normalizeEmail(localSigner.signer_email);
  // Map local signer roles to the `reason` strings Digio parties carry
  // (see initiate-agreement/route.ts). Previously this only built a key for
  // `dealer`, so iTarang / financier audit data never matched.
  const role = (localSigner.signer_role || "").toLowerCase().trim();
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
    (localSigner.provider_raw_response as any) ||
    null;

  const browser = extractBrowserParts(party);
  const status = pickString(party?.status, localSigner.signer_status) || undefined;
  const signingMethod = pickString(party?.sign_type, localSigner.signing_method) || undefined;

  return {
    sequence: seq,
    displayName: pickString(party?.name, localSigner.signer_name) || "Signer",
    email: pickString(party?.email, localSigner.signer_email) || undefined,
    mobile: pickString(party?.mobile, localSigner.signer_mobile) || undefined,
    requestedAt:
      pickString(party?.requested_on, party?.requested_at, party?.invited_on) ||
      (invitationAt ? invitationAt.toISOString() : null) ||
      localSigner.created_at?.toISOString() ||
      null,
    signedAt:
      pickString(party?.signed_on, party?.signed_at) ||
      (localSigner.signed_at ? localSigner.signed_at.toISOString() : null),
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

export async function renderDealerAuditTrailPdf(
  application: typeof dealerOnboardingApplications.$inferSelect
): Promise<Buffer> {
  const [localSigners, events] = await Promise.all([
    db
      .select()
      .from(dealerAgreementSigners)
      .where(eq(dealerAgreementSigners.application_id, application.id))
      .orderBy(asc(dealerAgreementSigners.created_at)),
    db
      .select()
      .from(dealerAgreementEvents)
      .where(eq(dealerAgreementEvents.application_id, application.id))
      .orderBy(desc(dealerAgreementEvents.created_at)),
  ]);

  // Try to fetch Digio document status + audit_log JSON to enrich per-signer details
  // (IP, browser, ESP, ASP ID, document hash, photo hash, certified name, etc.)
  let digioStatus: Record<string, unknown> | null = null;
  let digioAuditLog: Record<string, unknown> | null = null;
  if (application.provider_document_id) {
    const [statusResult, auditResult] = await Promise.allSettled([
      fetchDigioDocumentStatus(application.provider_document_id),
      fetchDigioAuditLogJson(application.provider_document_id),
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
    ["initiated", "created", "sent"].includes(String(e.event_type || "").toLowerCase()),
  );
  const invitationAt = invitationEvent?.created_at || application.created_at || null;

  const completedEvent = events.find((e) =>
    ["completed", "signing_complete", "signed"].includes(
      String(e.event_type || "").toLowerCase(),
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
        providerDocumentId: application.provider_document_id,
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
    (invitationEvent?.event_payload as any)?.ip,
  );

  const documentName = pickString(
    (digioStatus as any)?.file_name,
    application.company_name ? `${application.company_name}-agreement.pdf` : null,
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
    application.agreement_status,
  ) || "completed";

  const html = buildAuditTrailHtml({
    documentName,
    documentId: application.provider_document_id || application.id,
    status,
    ownerName,
    ownerEmail,
    invitationIp: invitationIp || undefined,
    signers,
    completedAt:
      digioCompletedAt ||
      completedEvent?.created_at?.toISOString() ||
      application.signed_at?.toISOString() ||
      null,
    completionEmails: signers
      .map((s) => s.email)
      .filter((e): e is string => !!e),
    generatedAt: new Date(),
  });

  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", right: "12mm", bottom: "14mm", left: "12mm" },
    });
    return Buffer.from(pdf);
  } finally {
    // Close only the PAGE — launchBrowser() returns a SHARED, long-lived
    // browser reused across requests; closing it would break concurrent
    // renders and force an expensive relaunch.
    await page.close().catch(() => {});
  }
}
