/**
 * Customer dossier — the read model the NBFC Acquire "Verification" step renders.
 *
 * Aggregates everything the dealer captured across the origination flow, all
 * keyed by `lead_id`:
 *   Step 1 — lead capture (identity, addresses, resident/insurance flags)
 *   Step 2 — KYC (Aadhaar/PAN/Bank verifications, documents, consent)
 *   Step 3 — co-borrower(s) + their KYC/docs, and supporting documents
 *   Step 4 — product selection (Section G)
 *
 * Read-only. PII is surfaced in full — the picked NBFC is the lender of record
 * (the rendered ZIP export uses the same data via @/lib/lead/profile-export).
 */
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  coBorrowerDocuments,
  coBorrowers,
  consentRecords,
  digilockerTransactions,
  kycDocuments,
  kycVerifications,
  leads,
  otherDocumentRequests,
  productSelections,
} from "@/lib/db/schema";

export interface CoBorrowerDossier {
  info: typeof coBorrowers.$inferSelect;
  docs: (typeof coBorrowerDocuments.$inferSelect)[];
}

export interface CustomerDossier {
  lead: typeof leads.$inferSelect;
  /** Primary applicant KYC verifications (aadhaar / pan / bank / rc / …). */
  customerKyc: (typeof kycVerifications.$inferSelect)[];
  /** Co-borrower KYC verifications (flat — typically one co-borrower). */
  coBorrowerKyc: (typeof kycVerifications.$inferSelect)[];
  /** Customer KYC document uploads. */
  customerDocs: (typeof kycDocuments.$inferSelect)[];
  /** Latest DigiLocker txn — holds the Aadhaar cross-match result. */
  aadhaar: typeof digilockerTransactions.$inferSelect | null;
  /** Consent records (primary + co-borrower). */
  consent: (typeof consentRecords.$inferSelect)[];
  coBorrowers: CoBorrowerDossier[];
  /** Step-3 supporting / additional documents. */
  supportingDocs: (typeof otherDocumentRequests.$inferSelect)[];
  productSelection: typeof productSelections.$inferSelect | null;
}

/** Fetches the full customer dossier for a lead, or null if the lead is gone. */
export async function getCustomerDossier(
  leadId: string,
): Promise<CustomerDossier | null> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return null;

  const [
    allKyc,
    allCustomerDocs,
    aadhaarRows,
    consent,
    coBorrowerRows,
    coBorrowerDocsRows,
    supportingDocs,
    selectionRows,
  ] = await Promise.all([
    db.select().from(kycVerifications).where(eq(kycVerifications.lead_id, leadId)),
    db
      .select()
      .from(kycDocuments)
      .where(and(eq(kycDocuments.lead_id, leadId), eq(kycDocuments.doc_for, "customer"))),
    db
      .select()
      .from(digilockerTransactions)
      .where(eq(digilockerTransactions.lead_id, leadId))
      .orderBy(desc(digilockerTransactions.created_at))
      .limit(1),
    db.select().from(consentRecords).where(eq(consentRecords.lead_id, leadId)),
    db.select().from(coBorrowers).where(eq(coBorrowers.lead_id, leadId)),
    db.select().from(coBorrowerDocuments).where(eq(coBorrowerDocuments.lead_id, leadId)),
    db.select().from(otherDocumentRequests).where(eq(otherDocumentRequests.lead_id, leadId)),
    db
      .select()
      .from(productSelections)
      .where(eq(productSelections.lead_id, leadId))
      .orderBy(desc(productSelections.created_at))
      .limit(1),
  ]);

  // Split KYC verifications by applicant. `applicant`/`verification_for` default
  // to the primary applicant for legacy rows.
  const isCoBorrower = (v: typeof kycVerifications.$inferSelect) =>
    v.applicant === "co_borrower" || v.verification_for === "co_borrower";
  const customerKyc = allKyc.filter((v) => !isCoBorrower(v));
  const coBorrowerKyc = allKyc.filter(isCoBorrower);

  // Group co-borrower docs under their owner.
  const docsByCb = new Map<string, (typeof coBorrowerDocuments.$inferSelect)[]>();
  for (const doc of coBorrowerDocsRows) {
    const key = doc.co_borrower_id ?? "";
    const arr = docsByCb.get(key) ?? [];
    arr.push(doc);
    docsByCb.set(key, arr);
  }

  return {
    lead,
    customerKyc,
    coBorrowerKyc,
    customerDocs: allCustomerDocs,
    aadhaar: aadhaarRows[0] ?? null,
    consent,
    coBorrowers: coBorrowerRows.map((info) => ({
      info,
      docs: docsByCb.get(info.id) ?? [],
    })),
    supportingDocs,
    productSelection: selectionRows[0] ?? null,
  };
}
