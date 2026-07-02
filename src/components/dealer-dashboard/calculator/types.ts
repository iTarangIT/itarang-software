// Shared types for the dealer Loan Calculator UI. These mirror the engine's
// CalcResult / SchemeCard output and the config-meta endpoint.

export interface ConfigMeta {
  models: { id: number; skuCode: string; displayName: string }[];
  tenures: number[];
  cities: { display: string; normalized: string; stateCode: string | null }[];
  filters: { expectedEmiRequired: boolean; upfrontRequired: boolean };
}

export interface UpfrontBreakdown {
  downPayment: number;
  advanceInstallmentsTotal: number;
  nbfcFileFee: number;
  processingFee: number;
  interestChargedUpfront: number;
  advanceInterest: number;
  totalUpfront: number;
}

export interface SchemeCard {
  nbfc: string;
  variant: "A" | "B";
  schemeCode: string;
  tenure: number;
  advance: number;
  remainingMonths: number;
  priceToDriver: number;
  loanAmount: number;
  emi: number;
  totalUpfront: number;
  breakdown: UpfrontBreakdown;
  estimatedTotalPayable: number;
  tier: "qualified" | "stretch";
  recommended: boolean;
  recommendationLabel?: string;
  stretchDistance?: number;
  stretch?: {
    failsEmi: boolean;
    failsUpfront: boolean;
    upfrontGap: number;
    requiredEmi: number;
    distance: number;
  };
}

export interface CalcResponse {
  outcome: "qualified" | "stretch_only" | "none";
  qualified: SchemeCard[];
  stretch: SchemeCard[];
  model: { id: number; skuCode: string; displayName: string };
  configVersionId: number | null;
  footer: { disclaimer: string; phone: string; email: string; whatsapp: string };
  cardDisclaimer: string;
  leadId: string;
}

export const inr = (n: number) =>
  "₹" + Math.round(n).toLocaleString("en-IN");
