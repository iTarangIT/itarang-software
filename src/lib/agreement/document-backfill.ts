// Best-effort backfill of agreement fields from the dealer's uploaded documents.
//
// When an admin initiates the agreement, some fields the PDF needs may be blank
// in provider_raw_response.submissionSnapshot.ownership — e.g. older onboardings
// captured before a field was added to extraction, or web dealers whose docs were
// never run through Gemini. This module fills those blanks from the documents:
//   • office address        ← GST certificate
//   • owner residential addr ← bank statement (holder address)
//   • bank branch            ← bank statement / cancelled cheque
//   • account type           ← bank statement / cancelled cheque
//
// Each document row already stores its onboarding-time Gemini extraction in
// `extracted_data`, so we read that FIRST (free). We only re-call Gemini
// (readDocument) when a document has no useful extracted data at all. If a
// document genuinely never contained a field, it stays blank — we never invent
// data. The whole thing is best-effort: any failure logs and leaves the field
// blank; it never blocks agreement initiation.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
} from "@/lib/db/schema";
import { getObject } from "@/lib/storage/s3";
import { readDocument } from "@/lib/whatsapp/extraction";
import { normalizeAccountType } from "@/lib/onboarding/account-type";
import { resolveDealerAddress } from "@/lib/onboarding/dealer-address";

type Rec = Record<string, any>;

function nonEmpty(v: unknown): boolean {
  return typeof v === "string" ? v.trim().length > 0 : v != null && v !== "";
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}

function parseProvider(value: unknown): Rec {
  if (value && typeof value === "object") return value as Rec;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return {};
}

function guessMime(doc: { mime_type?: string | null; file_name?: string | null; storage_path?: string | null }): string {
  if (doc.mime_type && doc.mime_type.trim()) return doc.mime_type.trim();
  const name = (doc.file_name || doc.storage_path || "").toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  return "application/pdf";
}

type DocRow = {
  document_type: string | null;
  bucket_name: string;
  storage_path: string;
  file_name: string | null;
  mime_type: string | null;
  extracted_data: unknown;
};

// Canonical extraction key (a DOC_FIELDS key in lib/whatsapp/prompts.ts) → every
// `document_type` string the DB may hold for it. The two onboarding paths write
// DIFFERENT strings for the same document — the WhatsApp orchestrator writes the
// short prompt names, while the web wizard
// (api/dealer/onboarding/submit/route.ts) writes its own longer keys. Looking up
// only the short name silently matched NOTHING for every web-onboarded dealer,
// which is why Schedule 3's office/residential address, branch and account type
// stayed blank on their agreements.
const DOC_TYPE_ALIASES: Record<string, string[]> = {
  gst: ["gst", "gst_certificate"],
  bank_statement: ["bank_statement", "bank_statement_3_months"],
  cancelled_cheque: ["cancelled_cheque", "undated_cheques"],
  udyam: ["udyam", "udyam_certificate"],
};

// Return the document's extracted fields, preferring the stored extraction and
// falling back to a fresh Gemini read only when the stored extraction has NONE
// of the fields we need (extraction failed at onboarding, or none was stored).
// `canonicalType` is the DOC_FIELDS key — NOT doc.document_type, which for a
// web-onboarded document is a string the prompt catalog has no spec for.
async function resolveDocFields(
  doc: DocRow,
  canonicalType: string,
  neededKeys: string[],
): Promise<Rec> {
  const existing: Rec =
    doc.extracted_data && typeof doc.extracted_data === "object"
      ? (doc.extracted_data as Rec)
      : {};

  if (neededKeys.some((k) => nonEmpty(existing[k]))) return existing;

  // Stored extraction is useless for us — try reading the file fresh.
  try {
    const buf = await getObject(doc.bucket_name, doc.storage_path);
    if (!buf) return existing;
    const res = await readDocument(buf, guessMime(doc), canonicalType);
    if (res.ok && res.fields && typeof res.fields === "object") {
      return { ...existing, ...res.fields };
    }
  } catch (err) {
    console.warn(
      "[agreement/document-backfill] re-extract failed for",
      doc.document_type,
      err instanceof Error ? err.message : err,
    );
  }
  return existing;
}

export type BackfilledAgreementData = {
  ownershipSnapshot: Rec;
  gstAddressesSnapshot: unknown;
  dealerOfficeAddress: string;
};

/**
 * Fill blank agreement fields on the application from its uploaded documents.
 * Mutates `application.provider_raw_response` in memory (so the caller's later
 * merge/persist keeps the enriched snapshot) and persists any change to the DB
 * immediately (so the paid-for extraction isn't lost if initiation later fails).
 * Fill-only: never overwrites a value that is already present.
 */
export async function backfillMissingAgreementFields(
  application: Rec,
): Promise<BackfilledAgreementData> {
  const providerData = parseProvider(application.provider_raw_response);
  const submissionSnapshot: Rec = providerData.submissionSnapshot || {};
  const ownershipSnapshot: Rec = { ...(submissionSnapshot.ownership || {}) };
  const gstAddressesSnapshot = submissionSnapshot.gstAddresses;

  let dealerOfficeAddress = resolveDealerAddress(
    application.business_address,
    gstAddressesSnapshot,
  );

  const missing = {
    office: !nonEmpty(dealerOfficeAddress),
    residential: !nonEmpty(ownershipSnapshot.ownerAddressLine1),
    branch: !nonEmpty(ownershipSnapshot.branch),
    accountType: !nonEmpty(ownershipSnapshot.accountType),
  };

  // Nothing to do — every agreement field already has data.
  if (!missing.office && !missing.residential && !missing.branch && !missing.accountType) {
    return { ownershipSnapshot, gstAddressesSnapshot, dealerOfficeAddress };
  }

  let rows: DocRow[] = [];
  try {
    rows = (await db
      .select({
        document_type: dealerOnboardingDocuments.document_type,
        bucket_name: dealerOnboardingDocuments.bucket_name,
        storage_path: dealerOnboardingDocuments.storage_path,
        file_name: dealerOnboardingDocuments.file_name,
        mime_type: dealerOnboardingDocuments.mime_type,
        extracted_data: dealerOnboardingDocuments.extracted_data,
      })
      .from(dealerOnboardingDocuments)
      .where(
        eq(dealerOnboardingDocuments.application_id, application.id),
      )) as DocRow[];
  } catch (err) {
    console.warn(
      "[agreement/document-backfill] failed to load documents:",
      err instanceof Error ? err.message : err,
    );
    return { ownershipSnapshot, gstAddressesSnapshot, dealerOfficeAddress };
  }

  // Find the document stored under ANY of a canonical type's known aliases.
  const byType = (canonical: string) => {
    const aliases = DOC_TYPE_ALIASES[canonical] ?? [canonical];
    return rows.find((r) =>
      aliases.includes((r.document_type || "").toLowerCase()),
    );
  };

  let ownershipChanged = false;
  let businessAddressToWrite: string | null = null;

  // ── Bank docs: residential address + branch + account type ────────────────
  if (missing.residential || missing.branch || missing.accountType) {
    const bankType = byType("bank_statement") ? "bank_statement" : "cancelled_cheque";
    const bankDoc = byType(bankType);
    if (bankDoc) {
      const f = await resolveDocFields(bankDoc, bankType, [
        "branch",
        "account_type",
        "address_line1",
        "city",
        "district",
        "state",
        "pincode",
      ]);

      if (missing.branch && nonEmpty(f.branch)) {
        ownershipSnapshot.branch = str(f.branch);
        ownershipChanged = true;
      }
      if (missing.accountType) {
        const at = normalizeAccountType(str(f.account_type));
        if (at) {
          ownershipSnapshot.accountType = at;
          ownershipChanged = true;
        }
      }
      // Each owner-address part fills independently. Gating city/district/state/
      // pincode behind a blank address line 1 left partially-captured addresses
      // permanently partial — Schedule 3 prints those parts as their own rows.
      if (missing.residential) {
        const parts: Array<[string, string]> = [
          ["ownerAddressLine1", "address_line1"],
          ["ownerCity", "city"],
          ["ownerDistrict", "district"],
          ["ownerState", "state"],
          ["ownerPinCode", "pincode"],
        ];
        for (const [snapshotKey, fieldKey] of parts) {
          if (!nonEmpty(ownershipSnapshot[snapshotKey]) && nonEmpty(f[fieldKey])) {
            ownershipSnapshot[snapshotKey] = str(f[fieldKey]);
            ownershipChanged = true;
          }
        }
      }
    }
  }

  // ── GST cert (then Udyam): office/company address ─────────────────────────
  // The Udyam certificate carries the official enterprise address and is the
  // fallback for dealers who uploaded no GST certificate or whose GST scan the
  // extractor couldn't read.
  if (missing.office) {
    for (const canonical of ["gst", "udyam"]) {
      const doc = byType(canonical);
      if (!doc) continue;
      const f = await resolveDocFields(doc, canonical, [
        "address",
        "address_line1",
        "city",
        "district",
        "state",
        "pincode",
      ]);
      const office =
        str(f.address) ||
        [f.address_line1, f.city, f.district, f.state, f.pincode]
          .map(str)
          .filter(Boolean)
          .join(", ");
      if (nonEmpty(office)) {
        dealerOfficeAddress = office;
        // Persist to the business_address column so the admin review page and
        // future initiations see it too (mirrors the onboarding write shape).
        businessAddressToWrite = JSON.stringify({
          address: str(f.address) || office,
          city: str(f.city),
          // district is carried too: Schedule 3 prints it as its own row, and
          // without it the cell stayed blank even though the GST/Udyam
          // certificate states the district.
          district: str(f.district),
          state: str(f.state),
          pincode: str(f.pincode),
        });
        break;
      }
    }
  }

  // Persist enriched snapshot (and business_address) so the paid extraction is
  // not lost, and mutate the in-memory application so the caller's later
  // provider_raw_response merge keeps these values.
  if (ownershipChanged || businessAddressToWrite) {
    const nextProvider: Rec = {
      ...providerData,
      submissionSnapshot: {
        ...submissionSnapshot,
        ownership: ownershipSnapshot,
      },
    };
    application.provider_raw_response = nextProvider;
    if (businessAddressToWrite) application.business_address = businessAddressToWrite;

    try {
      await db
        .update(dealerOnboardingApplications)
        .set({
          provider_raw_response: nextProvider,
          ...(businessAddressToWrite
            ? { business_address: businessAddressToWrite }
            : {}),
          updated_at: new Date(),
        })
        .where(eq(dealerOnboardingApplications.id, application.id));
    } catch (err) {
      console.warn(
        "[agreement/document-backfill] failed to persist backfill:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { ownershipSnapshot, gstAddressesSnapshot, dealerOfficeAddress };
}
