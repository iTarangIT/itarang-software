/**
 * Shared response types for the CaseWorkspaceSheet data layer. These mirror
 * the JSON shape returned by /api/nbfc/loans/[loanSanctionId]/case-detail
 * and friends.
 */
export interface CaseIdentity {
  customer: string | null;
  dealer: string | null;
  loan_id: string;
  outstanding: number | null;
  loan_start: string | null;
  tenure_months: number | null;
  phone: string | null;
  imei: string | null;
  city: string | null;
}

export interface CaseFlagged {
  confidence: string | null;
  last_updated: string | null;
  reasons: string[];
  cds_score: number | null;
  pci_score: number | null;
  immobilisation_eligible: boolean;
}

export interface CaseWhyThisMatters {
  default_probability_pct: number | null;
  evidence_confidence: string | null;
  data_freshness: string | null;
  knowledge_limits: string;
}

export interface CaseEmi {
  emi_amount: number | null;
  emi_due_dom: number | null;
  current_dpd: number;
}

export interface CaseWarranty {
  months: number | null;
  oem_expiry: string | null;
  status: string | null;
}

export interface CaseDetailResponse {
  loan_application_id: string;
  vehicleno: string | null;
  identity: CaseIdentity;
  flagged: CaseFlagged;
  why_this_matters: CaseWhyThisMatters;
  emi: CaseEmi;
  warranty: CaseWarranty | null;
}

export type RecommendedActionKey =
  | "payment_reminder"
  | "field_visit"
  | "immobilisation"
  | "restructuring";
