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
  verificationState: VerificationState;
  progress: number;
  uploadedAt?: string;
};

export type ContactCard = {
  id: string;
  name: string;
  phone: string;
  email: string;
};

export type CompanyStepData = {
  companyName: string;
  companyAddress: string;
  companyType: CompanyType;
  gstNumber: string;
  companyPanNumber: string;
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
  partnershipDeed: UploadFileItem | null;
  mouDocument: UploadFileItem | null;
  aoaDocument: UploadFileItem | null;
  partners: ContactCard[];
  directors: ContactCard[];
  bankName: string;
  accountNumber: string;
  ifsc: string;
  beneficiaryName: string;
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
  | "draft_generated"
  | "sent_for_signature"
  | "viewed_by_dealer"
  | "signed_by_dealer"
  | "completed"
  | "failed";

export type AgreementData = {
  agreementName: string;
  templateSource: string;
  provider: string;
  agreementVersion: string;
  generatedDate: string;
  agreementStatus: AgreementStatus;

  selectedTemplate: string;
  dealerLegalEntityName: string;
  authorizedSignatoryName: string;
  authorizedSignatoryEmail: string;
  authorizedSignatoryPhone: string;
  stampDutyState: string;

  dealerSignerName: string;
  dealerSignerEmail: string;
  dealerSignerPhone: string;
  dealerSigningMethod: string;

  salesManagerName: string;
  salesManagerEmail: string;
  salesManagerPhone: string;
  salesManagerSigningMethod: string;

  businessHeadName: string;
  businessHeadEmail: string;
  businessHeadPhone: string;
  businessHeadSigningMethod: string;

  requestId: string;
  lastActionTimestamp: string;
  signedAt: string;
  stampStatus: string;
  completionStatus: string;

  agreementTemplateFile: UploadCardValue | null;
  signedAgreementFile: UploadCardValue | null;
};

export type ReviewChecks = {
  confirmInfo: boolean;
  confirmDocs: boolean;
  agreeTerms: boolean;
};

export type DealerOnboardingState = {
  step: number;
  status: "draft" | "in_progress" | "under_review" | "action_needed" | "approved";
  lastSavedAt: string | null;
  company: CompanyStepData;
  compliance: ComplianceStepData;
  ownership: OwnershipBankingData;
  finance: FinanceData;
  agreement: AgreementData;
  reviewChecks: ReviewChecks;
  errors: Record<string, string>;
};