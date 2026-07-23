/**
 * Card input prefill for the NBFC Acquire "Verification" stage.
 *
 * The rich KYC cards (PAN / Bank / CIBIL / RC / Aadhaar) reused from the admin
 * side expect the captured KYC inputs (PAN, DOB, bank account, RC, name, phone,
 * address) plus per-document OCR data. The NBFC dossier (getCustomerDossier)
 * does NOT include `personal_details`, so this helper assembles the prefill from
 * `personalDetails` + `leads` + the customer's OCR'd documents. Read-only and
 * server-side — fed to <NbfcVerificationPanel> as the `kycInputs` prop.
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { coBorrowers, kycDocuments, leads, personalDetails } from "@/lib/db/schema";

export interface KycCardInputs {
  name: string;
  phone: string;
  email?: string;
  panNumber?: string;
  dob?: string;
  accountNumber?: string;
  ifsc?: string;
  bankName?: string;
  branch?: string;
  rcNumber?: string;
  address?: string;
  fatherName?: string;
  /** Per-document OCR blobs for the card autofill buttons. */
  ocr: {
    pan?: Record<string, unknown> | null;
    bank?: Record<string, unknown> | null;
    rc?: Record<string, unknown> | null;
  };
}

export interface NbfcKycInputs {
  primary: KycCardInputs;
  co_borrower: KycCardInputs | null;
}

const BANK_DOC_TYPES = [
  "bank_statement",
  "cheque_1",
  "cheque_2",
  "cheque_3",
  "cheque_4",
];

function toIsoDate(d: Date | string | null | undefined): string | undefined {
  if (!d) return undefined;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

export async function getNbfcKycInputs(leadId: string): Promise<NbfcKycInputs | null> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return null;

  const [pd] = await db
    .select()
    .from(personalDetails)
    .where(eq(personalDetails.lead_id, leadId))
    .limit(1);

  const docs = await db
    .select({ doc_type: kycDocuments.doc_type, ocr_data: kycDocuments.ocr_data })
    .from(kycDocuments)
    .where(and(eq(kycDocuments.lead_id, leadId), eq(kycDocuments.doc_for, "customer")));

  const ocrFor = (types: string[]) =>
    (docs.find((d) => types.includes(d.doc_type) && d.ocr_data)?.ocr_data as
      | Record<string, unknown>
      | null) ?? null;

  const name = lead.full_name || lead.owner_name || "";
  const phone = lead.phone || lead.mobile || lead.owner_contact || "";
  const address = pd?.local_address || lead.local_address || lead.current_address || "";

  const primary: KycCardInputs = {
    name,
    phone,
    email: pd?.email || undefined,
    panNumber: pd?.pan_no || undefined,
    dob: toIsoDate(pd?.dob ?? lead.dob),
    accountNumber: pd?.bank_account_number || undefined,
    ifsc: pd?.bank_ifsc || undefined,
    bankName: pd?.bank_name || undefined,
    branch: pd?.bank_branch || undefined,
    rcNumber: pd?.vehicle_rc || undefined,
    address: address || undefined,
    fatherName: pd?.father_husband_name || undefined,
    ocr: {
      pan: ocrFor(["pan_card"]),
      bank: ocrFor(BANK_DOC_TYPES),
      rc: ocrFor(["rc_copy"]),
    },
  };

  const [cb] = await db
    .select()
    .from(coBorrowers)
    .where(eq(coBorrowers.lead_id, leadId))
    .limit(1);

  // Bank / RC are not captured for co-borrowers — those cards render with empty,
  // editable inputs. Only PAN + identity are available.
  const co_borrower: KycCardInputs | null = cb
    ? {
        name: cb.full_name || "",
        phone: cb.phone || "",
        panNumber: cb.pan_no || undefined,
        dob: toIsoDate(cb.dob),
        address: cb.current_address || cb.address || cb.permanent_address || undefined,
        fatherName: cb.father_or_husband_name || undefined,
        ocr: {},
      }
    : null;

  return { primary, co_borrower };
}
