import type { UploadCardValue } from "./FileUploadCard";

export type CompanyType =
  | "sole_proprietorship"
  | "partnership_firm"
  | "private_limited_firm"
  | "";

export type VerificationState =
  | "idle"
  | "uploading"
  | "processing"
  | "verified"
  | "rejected"
  | "reupload";

export type UploadFileItem = {
  id: string;
  label: string;
  file: File | null;
  previewUrl: string | null;
  uploadedUrl?: string | null;
  storagePath?: string | null;
  bucketName?: string | null;
  verificationState: VerificationState;
  progress: number;
  uploadedAt?: string;
};

export type ContactCard = {
  id: string;
  name: string;
  designation?: string;
  phone: string;
  email: string;
  age?: string;
  photo?: UploadFileItem | null;
  addressLine1?: string;
  city?: string;
  district?: string;
  state?: string;
  pinCode?: string;
};

export type CompanyStepData = {
  companyName: string;
  companyAddress: string;
  companyType: CompanyType;
  gstNumber: string;
  companyPanNumber: string;
  businessSummary?: string;
  gstCertificate?: UploadFileItem | null;
  companyPanFile?: UploadFileItem | null;
};

export type ComplianceStepData = {
  itr3Years: UploadFileItem | null;
  bankStatement3Months: UploadFileItem | null;
  undatedCheques: UploadFileItem | null;
  passportPhoto: UploadFileItem | null;
  udyamCertificate: UploadFileItem | null;
};

export type OwnershipBankingData = {
  ownerName: string;
  ownerPhone: string;
  ownerEmail: string;
  ownerAge?: string;
  ownerPhoto?: UploadFileItem | null;
  ownerAddressLine1?: string;
  ownerCity?: string;
  ownerDistrict?: string;
  ownerState?: string;
  ownerPinCode?: string;

  partnershipDeed: UploadFileItem | null;
  mouDocument: UploadFileItem | null;
  aoaDocument: UploadFileItem | null;

  partners: ContactCard[];
  directors: ContactCard[];

  bankName: string;
  accountNumber: string;
  ifsc: string;
  beneficiaryName: string;
  branch?: string;
  accountType?: "current" | "savings" | "od" | "";
};

export type FinanceData = {
  enableFinance: "yes" | "no" | "";
  financeContactPerson: string;
  financeContactPhone: string;
  financeContactEmail: string;
  financeRemarks: string;
};

export type AgreementStatus =
  | "not_generated"
  | "draft_ready"
  | "sent_for_signature"
  | "viewed"
  | "partially_signed"
  | "completed"
  | "expired"
  | "failed";

export type SigningMethod =
  | ""
  | "aadhaar_esign"
  | "electronic_signature"
  | "dsc_signature";

export type AgreementParty = {
  name: string;
  designation: string;
  email: string;
  mobile: string;
  address: string;
  signingMethod: SigningMethod;
};

export type SigningOrderKey =
  | "dealer"
  | "financier"
  | "itarang_1"
  | "itarang_2";

export type AgreementData = {
  agreementName: string;
  provider: string;
  agreementVersion: string;
  generatedDate: string;
  agreementStatus: AgreementStatus;

  dateOfSigning: string;
  mouDate: string;
  expiryDays: number;

  dealerLegalEntityName: string;
  authorizedSignatoryName: string;
  authorizedSignatoryEmail: string;
  authorizedSignatoryPhone: string;
  stampDutyState: string;

  dealerSignerName: string;
  dealerSignerDesignation: string;
  dealerSignerEmail: string;
  dealerSignerPhone: string;
  dealerSigningMethod: SigningMethod;

  financierName: string;

  isOemFinancing: boolean;
  vehicleType: string;
  manufacturer: string;
  brand: string;
  statePresence: string;

  itarangSignatory1: AgreementParty;
  itarangSignatory2: AgreementParty;
  financierSignatory: AgreementParty;

  signingOrder: SigningOrderKey[];
  sequentialSigning: true;

  requestId: string;
  providerDocumentId: string;
  providerSigningUrl: string;
  providerRawResponse: string;
  lastActionTimestamp: string;
  signedAt: string;
  stampStatus: string;
  completionStatus: string;

  signedAgreementFile: UploadCardValue | null;
};

export type ReviewChecks = {
  confirmInfo: boolean;
  confirmDocs: boolean;
  agreeTerms: boolean;
};

export type DealerOnboardingState = {
  step: number;
  status:
  | "draft"
  | "in_progress"
  | "submitted"
  | "pending_sales_head"
  | "under_review"
  | "agreement_in_progress"
  | "agreement_completed"
  | "correction_requested"
  | "rejected"
  | "approved";
  lastSavedAt: string | null;
  dealerId: string;
  dealerDisplayName: string;
  company: CompanyStepData;
  compliance: ComplianceStepData;
  ownership: OwnershipBankingData;
  finance: FinanceData;
  agreement: AgreementData;
  reviewChecks: ReviewChecks;
  errors: Record<string, string>;
};