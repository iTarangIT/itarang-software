/**
 * Bajaj Finance Limited — public RBI/MCA registration data for the iTarang
 * NBFC onboarding spec. Mirror of ~/.claude/skills/nbfc-onboarding/fixtures/
 * bajaj-finance.ts (skill file is the source of truth; copy into this repo so
 * the spec can resolve it with a relative import).
 */

export const bajajFinanceNbfc = {
  legalName: "Bajaj Finance Limited",
  shortName: "Bajaj Finance",
  rbiRegistrationNo: "N-13.00243.00.00.0000.00000.00",
  cin: "L65910MH1987PLC042961",
  gstNumber: "27AABCB1518L1ZS",
  panNumber: "AABCB1518L",
  nbfcType: "nbfc_icc" as const,
  registeredAddress: {
    line1: "Bajaj Auto Ltd. Complex",
    line2: "Mumbai-Pune Road",
    city: "Pune",
    district: "Pune",
    state: "Maharashtra",
    pin: "411035",
  },
  activeGeographies: ["MH", "GJ", "RJ", "KA", "TN", "DL", "UP", "MP", "TG", "AP"],
  primaryContactName: "Rajeev Jain",
  primaryContactEmail: "rajeev.jain.test@example.com",
  primaryContactPhone: "9999999999",
  grievanceOfficerName: "Anant Damle (test)",
  grievanceHelpline: "02071177777",
  grievanceUrl: "https://www.bajajfinserv.in/grievance-redressal",
  nodalOfficer: "Test Nodal Officer",
  partnershipDate: "2026-05-03",
  fldgTerms: "5% FLDG capped at portfolio level, replenished quarterly",
};

export const bajajLoanProduct = {
  productName: "Bajaj E-Rickshaw Finance 2026",
  eligibleBatteryCategories: ["3W", "2W"] as const,
  loanAmountMin: 50_000,
  loanAmountMax: 500_000,
  tenureMonthsMin: 12,
  tenureMonthsMax: 36,
  minRoiPct: 12.5,
  maxRoiPct: 18.0,
  downPaymentPct: 15.0,
  subventionAvailable: true,
  fileChargeFixed: 1500,
  fileChargePct: 1.0,
  disbursementMethod: "direct_to_dealer" as const,
  status: "active" as const,
};

export const bajajLspSigners = {
  nbfcSignatoryName: "Sanjiv Bajaj",
  nbfcSignatoryEmail: "sanjiv.bajaj.test@example.com",
  itarangSignatory1Name: "iTarang CEO",
  itarangSignatory1Email: "ceo.test@itarang.com",
  itarangSignatory2Name: "iTarang COO",
  itarangSignatory2Email: "coo.test@itarang.com",
};

export const bajajCorExpiry = "2029-03-05";
