"use client";

import { create } from "zustand";
import { DealerOnboardingState, UploadFileItem } from "@/components/onboarding/onboardingTypes";
import { validateStep } from "@/components/onboarding/onboardingSchemas";

const makeUploadItem = (label: string): UploadFileItem => ({
  id: crypto.randomUUID(),
  label,
  file: null,
  previewUrl: null,
  verificationState: "idle",
  progress: 0,
});

type StoreActions = {
  setStep: (step: number) => void;
  nextStep: () => boolean;
  prevStep: () => void;
  setField: (section: keyof DealerOnboardingState, field: string, value: any) => void;
  setErrors: (errors: Record<string, string>) => void;
  clearError: (key: string) => void;
  saveDraft: () => void;
  setUpload: (path: string, fileItem: UploadFileItem) => void;
  addPartner: () => void;
  updatePartner: (id: string, field: "name" | "phone" | "email", value: string) => void;
  removePartner: (id: string) => void;
  addDirector: () => void;
  updateDirector: (id: string, field: "name" | "phone" | "email", value: string) => void;
  removeDirector: (id: string) => void;
};

const initialState: DealerOnboardingState = {
  step: 1,
  status: "draft",
  lastSavedAt: null,
  company: {
    companyName: "",
    companyAddress: "",
    companyType: "",
    gstNumber: "",
    companyPanNumber: "",
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
    partnershipDeed: makeUploadItem("Partnership Deed"),
    mouDocument: makeUploadItem("MoU"),
    aoaDocument: makeUploadItem("AoA"),
    partners: [],
    directors: [],
    bankName: "",
    accountNumber: "",
    ifsc: "",
    beneficiaryName: "",
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

  salesManagerName: "",
  salesManagerEmail: "",
  salesManagerPhone: "",
  salesManagerSigningMethod: "OTP-based signing",

  businessHeadName: "",
  businessHeadEmail: "",
  businessHeadPhone: "",
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
};

export const useOnboardingStore = create<DealerOnboardingState & StoreActions>((set, get) => ({
  ...initialState,

  setStep: (step) => set({ step }),

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
        return { step: 4 };
      }
      return { step: Math.max(state.step - 1, 1) };
    }),

  setField: (section, field, value) =>
    set((state) => ({
      ...state,
      [section]: {
        ...(state[section] as any),
        [field]: value,
      },
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
      const [section, field] = path.split(".");
      nextState[section] = { ...nextState[section], [field]: fileItem };
      nextState.lastSavedAt = new Date().toISOString();
      return nextState;
    }),

  addPartner: () =>
    set((state) => ({
      ownership: {
        ...state.ownership,
        partners: [
          ...state.ownership.partners,
          { id: crypto.randomUUID(), name: "", phone: "", email: "" },
        ],
      },
    })),

  updatePartner: (id, field, value) =>
    set((state) => ({
      ownership: {
        ...state.ownership,
        partners: state.ownership.partners.map((partner) =>
          partner.id === id ? { ...partner, [field]: value } : partner
        ),
      },
    })),

  removePartner: (id) =>
    set((state) => ({
      ownership: {
        ...state.ownership,
        partners: state.ownership.partners.filter((partner) => partner.id !== id),
      },
    })),

  addDirector: () =>
    set((state) => ({
      ownership: {
        ...state.ownership,
        directors: [
          ...state.ownership.directors,
          { id: crypto.randomUUID(), name: "", phone: "", email: "" },
        ],
      },
    })),

  updateDirector: (id, field, value) =>
    set((state) => ({
      ownership: {
        ...state.ownership,
        directors: state.ownership.directors.map((director) =>
          director.id === id ? { ...director, [field]: value } : director
        ),
      },
    })),

  removeDirector: (id) =>
    set((state) => ({
      ownership: {
        ...state.ownership,
        directors: state.ownership.directors.filter((director) => director.id !== id),
      },
    })),
}));