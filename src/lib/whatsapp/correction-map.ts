// Correction catalog keys (web onboarding) ↔ WhatsApp document types.
//
// The correction catalog (src/lib/onboarding/correction-catalog.ts) was written
// for the WEB wizard, whose documents are stored under keys like
// "gst_certificate" / "bank_statement_3_months". The WhatsApp chatbot stores the
// SAME documents under shorter types ("gst", "bank_statement", …) — see
// src/lib/whatsapp/checklist.ts. When an admin requests a correction on a
// WhatsApp-onboarded dealer, the round/items use the catalog keys but the
// dealer's existing docs (and the slots the bot collects into) use WhatsApp
// types. This map bridges the two so we can (a) snapshot the dealer's previous
// document and (b) drive the in-chat re-upload into the right slot.

import type { CorrectionDocumentKey } from "@/lib/onboarding/correction-catalog";

/** Catalog document key → WhatsApp `document_type`. */
export const CATALOG_TO_WHATSAPP_DOC: Record<CorrectionDocumentKey, string> = {
  gst_certificate: "gst",
  company_pan: "company_pan",
  itr_3_years: "itr",
  bank_statement_3_months: "bank_statement",
  undated_cheques: "cancelled_cheque",
  passport_photo: "owner_photo",
  udyam_certificate: "udyam",
  owner_photo: "owner_photo",
  partnership_deed: "partnership_deed",
  mou_document: "mou",
  aoa_document: "aoa",
};

/** WhatsApp `document_type` → first matching catalog document key. */
export const WHATSAPP_TO_CATALOG_DOC: Record<string, CorrectionDocumentKey> =
  Object.entries(CATALOG_TO_WHATSAPP_DOC).reduce(
    (acc, [catalogKey, waType]) => {
      // Multiple catalog keys can map to one WhatsApp type (owner_photo /
      // passport_photo → owner_photo). Keep the first — only used for display.
      if (!(waType in acc)) acc[waType] = catalogKey as CorrectionDocumentKey;
      return acc;
    },
    {} as Record<string, CorrectionDocumentKey>,
  );

/** Map a catalog document key to its WhatsApp slot (null if unknown). */
export function catalogDocToWhatsapp(key: string): string | null {
  return (CATALOG_TO_WHATSAPP_DOC as Record<string, string>)[key] ?? null;
}
