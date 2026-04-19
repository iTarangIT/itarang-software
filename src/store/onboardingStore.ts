"use client";

import { create } from "zustand";
import type {
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

type AgreementStatusUpdatePayload = {
  agreementStatus?: DealerOnboardingState["agreement"]["agreementStatus"];
  providerDocumentId?: DealerOnboardingState["agreement"]["providerDocumentId"];
  providerSigningUrl?: DealerOnboardingState["agreement"]["providerSigningUrl"];
  providerRawResponse?: DealerOnboardingState["agreement"]["providerRawResponse"];
  signedAt?: DealerOnboardingState["agreement"]["signedAt"];
  lastActionTimestamp?: DealerOnboardingState["agreement"]["lastActionTimestamp"];
  completionStatus?: DealerOnboardingState["agreement"]["completionStatus"];
  stampStatus?: DealerOnboardingState["agreement"]["stampStatus"];
  requestId?: DealerOnboardingState["agreement"]["requestId"];
  signedAgreementFile?: DealerOnboardingState["agreement"]["signedAgreementFile"];
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
  resetAgreementState: () => void;
  updateAgreementStatus: (payload: AgreementStatusUpdatePayload) => void;
};

function createInitialAgreementState(): DealerOnboardingState["agreement"] {
  return {
    agreementName: "Dealer Finance Enablement Agreement",
    provider: "Digio",
    agreementVersion: "v1.0",
    generatedDate: "",
    agreementStatus: "not_generated",

    dateOfSigning: "",
    mouDate: "",
    expiryDays: 5,

    dealerLegalEntityName: "",
    authorizedSignatoryName: "",
    authorizedSignatoryEmail: "",
    authorizedSignatoryPhone: "",
    stampDutyState: "",

    dealerSignerName: "",
    dealerSignerDesignation: "",
    dealerSignerEmail: "",
    dealerSignerPhone: "",
    dealerSigningMethod: "",

    salesManager: {
      name: "",
      email: "",
      mobile: "",
    },
    financierName: "",

    isOemFinancing: false,
    vehicleType: "",
    manufacturer: "",
    brand: "",
    statePresence: "",

    itarangSignatory1: {
      name: "",
      designation: "",
      email: "",
      mobile: "",
      address: "",
      signingMethod: "",
    },

    itarangSignatory2: {
      name: "",
      designation: "",
      email: "",
      mobile: "",
      address: "",
      signingMethod: "",
    },

    financierSignatory: {
      name: "",
      designation: "",
      email: "",
      mobile: "",
      address: "",
      signingMethod: "",
    },

    // Fixed Signing Order
    signingOrder: ["dealer", "financier", "itarang_1", "itarang_2"],
    sequentialSigning: true,

    requestId: "",
    providerDocumentId: "",
    providerSigningUrl: "",
    providerRawResponse: "",
    lastActionTimestamp: "",
    signedAt: "",
    stampStatus: "pending",
    completionStatus: "pending",
    signedAgreementFile: null,
  };
}

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
    ownerLandline: "",
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

  agreement: createInitialAgreementState(),

  reviewChecks: {
    confirmInfo: false,
    confirmDocs: false,
    agreeTerms: false,
  },

  errors: {},
};

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
            designation: "",
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
          (partner) =>
            partner.id === id ? { ...partner, [field]: value } : partner
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
            designation: "",
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
          (director) =>
            director.id === id ? { ...director, [field]: value } : director
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

  resetAgreementState: () =>
    set((state) => ({
      agreement: {
        ...createInitialAgreementState(),
        dateOfSigning: state.agreement.dateOfSigning,
        expiryDays: state.agreement.expiryDays,
        dealerSignerName: state.agreement.dealerSignerName,
        dealerSignerDesignation: state.agreement.dealerSignerDesignation,
        dealerSignerEmail: state.agreement.dealerSignerEmail,
        dealerSignerPhone: state.agreement.dealerSignerPhone,
        dealerSigningMethod: state.agreement.dealerSigningMethod,
        salesManager: { ...state.agreement.salesManager },
        financierName: state.agreement.financierName,
        mouDate: state.agreement.mouDate,
        isOemFinancing: state.agreement.isOemFinancing,
        vehicleType: state.agreement.vehicleType,
        manufacturer: state.agreement.manufacturer,
        brand: state.agreement.brand,
        statePresence: state.agreement.statePresence,
        itarangSignatory1: { ...state.agreement.itarangSignatory1 },
        itarangSignatory2: { ...state.agreement.itarangSignatory2 },
        financierSignatory: { ...state.agreement.financierSignatory },
      },
      lastSavedAt: new Date().toISOString(),
    })),

  updateAgreementStatus: (payload) =>
    set((state) => ({
      agreement: {
        ...state.agreement,
        agreementStatus:
          payload.agreementStatus ?? state.agreement.agreementStatus,
        providerDocumentId:
          payload.providerDocumentId ?? state.agreement.providerDocumentId,
        providerSigningUrl:
          payload.providerSigningUrl ?? state.agreement.providerSigningUrl,
        providerRawResponse:
          payload.providerRawResponse ?? state.agreement.providerRawResponse,
        signedAt: payload.signedAt ?? state.agreement.signedAt,
        lastActionTimestamp:
          payload.lastActionTimestamp ?? new Date().toISOString(),
        completionStatus:
          payload.completionStatus ?? state.agreement.completionStatus,
        stampStatus: payload.stampStatus ?? state.agreement.stampStatus,
        requestId: payload.requestId ?? state.agreement.requestId,
        signedAgreementFile:
          payload.signedAgreementFile ?? state.agreement.signedAgreementFile,
      },
      lastSavedAt: new Date().toISOString(),
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
      agreementStatus: state.agreement.agreementStatus,
      providerDocumentId: state.agreement.providerDocumentId,
      requestId: state.agreement.requestId,
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
      status: "submitted",
      lastSavedAt: new Date().toISOString(),
      errors: {},
    });

    return generatedDealerId;
  },
}));