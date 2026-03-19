"use client";

import { create } from "zustand";
import {
  DealerOnboardingState,
  UploadFileItem,
} from "@/components/onboarding/onboardingTypes";
import { validateStep } from "@/components/onboarding/onboardingSchemas";

const makeUploadItem = (label: string): UploadFileItem => ({
  id: crypto.randomUUID(),
  label,
  file: null,
  previewUrl: null,
  verificationState: "idle",
  progress: 0,
});

function generateDealerId() {
  const now = new Date();

  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const random = Math.floor(1000 + Math.random() * 9000);

  return `ITD-${yyyy}${mm}${dd}-${random}`;
}

type ExtendedContactRow = {
  id: string;
  name: string;
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

type StoreActions = {
  setStep: (step: number) => void;
  nextStep: () => boolean;
  prevStep: () => void;
  setField: (
    section: keyof DealerOnboardingState,
    field: string,
    value: any
  ) => void;
  setErrors: (errors: Record<string, string>) => void;
  clearError: (key: string) => void;
  saveDraft: () => void;
  setUpload: (path: string, fileItem: UploadFileItem) => void;
  addPartner: () => void;
  updatePartner: (id: string, field: string, value: any) => void;
  removePartner: (id: string) => void;
  addDirector: () => void;
  updateDirector: (id: string, field: string, value: any) => void;
  removeDirector: (id: string) => void;
  completeOnboarding: () => string;
};

const initialState: DealerOnboardingState = {
  step: 1,
  status: "draft",
  lastSavedAt: null,
  dealerId: "",
  dealerDisplayName: "",

  company: {
    companyName: "",
    companyAddress: "",
    companyType: "",
    gstNumber: "",
    companyPanNumber: "",
    businessSummary: "",
    gstCertificate: makeUploadItem("GST Certificate"),
    companyPanFile: makeUploadItem("Company PAN"),
  },

  compliance: {
    itr3Years: makeUploadItem("Last 3 Years Company Income Tax Returns"),
    bankStatement3Months: makeUploadItem("Last 3 Months Company Bank Statement"),
    undatedCheques: makeUploadItem("4 Undated Cheques"),
    passportPhoto: makeUploadItem("Passport Size Photograph"),
    udyamCertificate: makeUploadItem("Udyam Registration Certificate"),
  },

  ownership: {
    ownerName: "",
    ownerPhone: "",
    ownerEmail: "",
    ownerAge: "",
    ownerPhoto: makeUploadItem("Owner Photograph"),
    ownerAddressLine1: "",
    ownerCity: "",
    ownerDistrict: "",
    ownerState: "",
    ownerPinCode: "",

    partnershipDeed: makeUploadItem("Partnership Deed"),
    mouDocument: makeUploadItem("MoU"),
    aoaDocument: makeUploadItem("AoA"),

    partners: [],
    directors: [],

    bankName: "",
    accountNumber: "",
    ifsc: "",
    beneficiaryName: "",
    branch: "",
    accountType: "",
  },

  finance: {
    enableFinance: "",
    financeContactPerson: "",
    financeContactPhone: "",
    financeContactEmail: "",
    financeRemarks: "",
  },

  agreement: {
    agreementName: "Dealer Finance Enablement Agreement",
    templateSource: "iTarang approved template",
    provider: "Signzy Contract 360",
    agreementVersion: "v1.0",
    generatedDate: "",
    agreementStatus: "not_generated",

    selectedTemplate: "Tarang Dealer Agreement Template",
    dealerLegalEntityName: "",
    authorizedSignatoryName: "",
    authorizedSignatoryEmail: "",
    authorizedSignatoryPhone: "",
    stampDutyState: "",

    dealerSignerName: "",
    dealerSignerEmail: "",
    dealerSignerPhone: "",
    dealerSigningMethod: "Aadhaar eSign",

    salesManagerName: "Amit Verma",
    salesManagerEmail: "amit.verma@itarang.com",
    salesManagerPhone: "9876543210",
    salesManagerSigningMethod: "OTP-based signing",

    businessHeadName: "Sanjay Mehta",
    businessHeadEmail: "sanjay.mehta@itarang.com",
    businessHeadPhone: "9123456780",
    businessHeadSigningMethod: "Digital signature workflow",
    requestId: "",
    lastActionTimestamp: "",
    signedAt: "",
    stampStatus: "Pending",
    completionStatus: "Not Started",

    agreementTemplateFile: null,
    signedAgreementFile: null,
  },

  reviewChecks: {
    confirmInfo: false,
    confirmDocs: false,
    agreeTerms: false,
  },

  errors: {},
} as DealerOnboardingState;

function removeStaleSubmitErrors(errors: Record<string, string>) {
  const nextErrors = { ...errors };

  Object.keys(nextErrors).forEach((key) => {
    const value = nextErrors[key];
    if (
      value === "Primary contact name is required before submission" ||
      value === "Primary contact phone is required before submission" ||
      value === "Primary contact email is required before submission"
    ) {
      delete nextErrors[key];
    }
  });

  return nextErrors;
}

export const useOnboardingStore = create<
  DealerOnboardingState & StoreActions
>((set, get) => ({
  ...initialState,

  setStep: (step) => set({ step, errors: {} }),

  nextStep: () => {
    const current = get();
    const errors = validateStep(current);

    if (Object.keys(errors).length > 0) {
      set({ errors });
      return false;
    }

    if (current.step === 4 && current.finance.enableFinance === "no") {
      set({
        step: 6,
        errors: {},
        status: "in_progress",
        lastSavedAt: new Date().toISOString(),
      });
      return true;
    }

    set((state) => ({
      step: Math.min(state.step + 1, 6),
      errors: {},
      status: "in_progress",
      lastSavedAt: new Date().toISOString(),
    }));

    return true;
  },

  prevStep: () =>
    set((state) => {
      if (state.step === 6 && state.finance.enableFinance === "no") {
        return { step: 4, errors: {} };
      }

      return {
        step: Math.max(state.step - 1, 1),
        errors: {},
      };
    }),

  setField: (section, field, value) =>
    set((state) => ({
      ...state,
      [section]: {
        ...(state[section] as any),
        [field]: value,
      },
      errors: removeStaleSubmitErrors(state.errors),
      lastSavedAt: new Date().toISOString(),
    })),

  setErrors: (errors) => set({ errors }),

  clearError: (key) =>
    set((state) => {
      const nextErrors = { ...state.errors };
      delete nextErrors[key];
      return { errors: nextErrors };
    }),

  saveDraft: () =>
    set({
      status: "draft",
      lastSavedAt: new Date().toISOString(),
    }),

  setUpload: (path, fileItem) =>
    set((state) => {
      const nextState: any = { ...state };
      const parts = path.split(".");

      if (parts.length === 2) {
        const [section, field] = parts;
        nextState[section] = {
          ...nextState[section],
          [field]: fileItem,
        };
      } else if (parts.length === 4) {
        const [section, listKey, itemId, field] = parts;
        nextState[section] = {
          ...nextState[section],
          [listKey]: (nextState[section][listKey] || []).map((item: any) =>
            item.id === itemId ? { ...item, [field]: fileItem } : item
          ),
        };
      }

      nextState.errors = removeStaleSubmitErrors(state.errors);
      nextState.lastSavedAt = new Date().toISOString();
      return nextState;
    }),

  addPartner: () =>
    set((state) => ({
      ownership: {
        ...state.ownership,
        partners: [
          ...(state.ownership.partners as ExtendedContactRow[]),
          {
            id: crypto.randomUUID(),
            name: "",
            phone: "",
            email: "",
            age: "",
            photo: makeUploadItem("Partner Photograph"),
            addressLine1: "",
            city: "",
            district: "",
            state: "",
            pinCode: "",
          },
        ],
      },
      errors: {},
    })),

  updatePartner: (id, field, value) =>
    set((state) => ({
      ownership: {
        ...state.ownership,
        partners: (state.ownership.partners as ExtendedContactRow[]).map(
          (partner) => (partner.id === id ? { ...partner, [field]: value } : partner)
        ),
      },
      errors: {},
    })),

  removePartner: (id) =>
    set((state) => ({
      ownership: {
        ...state.ownership,
        partners: (state.ownership.partners as ExtendedContactRow[]).filter(
          (partner) => partner.id !== id
        ),
      },
      errors: {},
    })),

  addDirector: () =>
    set((state) => ({
      ownership: {
        ...state.ownership,
        directors: [
          ...(state.ownership.directors as ExtendedContactRow[]),
          {
            id: crypto.randomUUID(),
            name: "",
            phone: "",
            email: "",
            age: "",
            photo: makeUploadItem("Director Photograph"),
            addressLine1: "",
            city: "",
            district: "",
            state: "",
            pinCode: "",
          },
        ],
      },
      errors: {},
    })),

  updateDirector: (id, field, value) =>
    set((state) => ({
      ownership: {
        ...state.ownership,
        directors: (state.ownership.directors as ExtendedContactRow[]).map(
          (director) => (director.id === id ? { ...director, [field]: value } : director)
        ),
      },
      errors: {},
    })),

  removeDirector: (id) =>
    set((state) => ({
      ownership: {
        ...state.ownership,
        directors: (state.ownership.directors as ExtendedContactRow[]).filter(
          (director) => director.id !== id
        ),
      },
      errors: {},
    })),

  completeOnboarding: () => {
    const state = get();

    const generatedDealerId = state.dealerId || generateDealerId();
    const dealerDisplayName = state.company.companyName || "Unnamed Dealer";

    const dealerDashboardData = {
      dealerId: generatedDealerId,
      dealerDisplayName,
      companyName: state.company.companyName,
      companyType: state.company.companyType,
      gstNumber: state.company.gstNumber,
      financeEnabled: state.finance.enableFinance,
      submittedAt: new Date().toISOString(),
    };

    if (typeof window !== "undefined") {
      localStorage.setItem(
        "dealerDashboardData",
        JSON.stringify(dealerDashboardData)
      );
    }

    set({
      dealerId: generatedDealerId,
      dealerDisplayName,
      status: "under_review",
      lastSavedAt: new Date().toISOString(),
      errors: {},
    });

    return generatedDealerId;
  },
}));