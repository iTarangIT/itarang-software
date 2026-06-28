"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  CompanyStepData,
  ComplianceStepData,
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
  hydrateFromApplication: (app: unknown, documents: unknown) => void;
  setErrors: (errors: Record<string, string>) => void;
  clearError: (key: string) => void;
  saveDraft: () => void;
  // Wipe the wizard back to a blank step-1 state for a brand-new dealer, so the
  // next autosave creates a fresh draft row instead of editing the last one.
  reset: () => void;
  // Autosave the in-progress wizard to its dealer_onboarding_applications draft
  // row (server side), so a closed laptop / switched dealer can be resumed.
  persistDraft: () => Promise<void>;
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
  internalApplicationId: null,
  draftApplicationId: null,

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
    ownerAadhaarNumber: "",
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

// The wizard upload slots whose document_type strings round-trip through BOTH
// the save route (dealerOnboardingDocuments) and hydrateFromApplication — i.e.
// the documents that are actually re-attached on resume. Keep this list in sync
// with the switch in hydrateFromApplication and buildDocument() in StepReview.
const PERSISTED_DOC_SLOTS: Array<{
  type: string;
  pick: (s: DealerOnboardingState) => UploadFileItem | null | undefined;
}> = [
  { type: "gst_certificate", pick: (s) => s.company.gstCertificate },
  { type: "pan_card", pick: (s) => s.company.companyPanFile },
  { type: "itr_3_years", pick: (s) => s.compliance.itr3Years },
  { type: "bank_statement_3_months", pick: (s) => s.compliance.bankStatement3Months },
  { type: "undated_cheques", pick: (s) => s.compliance.undatedCheques },
  { type: "passport_photo", pick: (s) => s.compliance.passportPhoto },
  { type: "udyam_certificate", pick: (s) => s.compliance.udyamCertificate },
];

// Build the documents array for the save route from any upload slot that has a
// storagePath (i.e. the file already landed in storage via FileUploadCard).
// Gate on storagePath, NOT on `file` — a resumed draft restores storagePath but
// not the in-memory File, and those restored docs must still persist.
function collectUploadedDocuments(state: DealerOnboardingState) {
  return PERSISTED_DOC_SLOTS.flatMap(({ type, pick }) => {
    const item = pick(state);
    if (!item?.storagePath) return [];
    const fileName =
      item.file?.name ||
      item.storagePath.split("/").pop() ||
      item.label ||
      type;
    return [
      {
        documentType: type,
        bucketName: item.bucketName ?? "dealer-documents",
        storagePath: item.storagePath,
        fileName,
        fileUrl: item.uploadedUrl ?? null,
      },
    ];
  });
}

// Map the wizard state onto the body shape /api/dealer-onboarding/save expects.
// Uploaded documents are included ONLY when at least one slot has a storagePath
// — the save route treats a present `documents` array as a full replace, so we
// must never send an empty list (it would delete the row's existing uploads).
// Before any upload, or before hydrate populates the slots, the field is omitted
// so existing document rows are left untouched.
function buildSavePayload(state: DealerOnboardingState) {
  const o = state.ownership;
  const c = state.company;
  const documents = collectUploadedDocuments(state);
  return {
    ...(documents.length > 0 ? { documents } : {}),
    applicationId:
      state.draftApplicationId ?? state.internalApplicationId ?? undefined,
    draftStep: state.step,
    dealerCode: state.dealerId || undefined,
    companyName: c.companyName,
    companyType: c.companyType,
    gstNumber: c.gstNumber,
    panNumber: c.companyPanNumber,
    businessAddress: c.companyAddress
      ? { address: c.companyAddress }
      : undefined,
    financeEnabled: state.finance.enableFinance === "yes",
    ownerName: o.ownerName,
    ownerPhone: o.ownerPhone,
    ownerEmail: o.ownerEmail,
    ownerLandline: o.ownerLandline,
    bankName: o.bankName,
    accountNumber: o.accountNumber,
    beneficiaryName: o.beneficiaryName,
    ifscCode: o.ifsc,
    agreement: {
      salesManager: state.agreement.salesManager,
      itarangSignatory1: state.agreement.itarangSignatory1,
      itarangSignatory2: state.agreement.itarangSignatory2,
      agreementStatus: state.agreement.agreementStatus,
    },
  };
}

// ── localStorage safety net (zustand persist) ────────────────────────────────
// Persist only serializable wizard content. File / Blob / object-URL fields on
// the upload slots cannot survive a JSON round-trip (and a stale object URL is
// useless after reload), so they are stripped here and rebuilt from a fresh
// initialState on merge.
function partializeOnboarding(state: DealerOnboardingState & StoreActions) {
  const stripRow = (row: Record<string, unknown>) => {
    const { photo, ...rest } = row;
    void photo;
    return rest;
  };
  const { signedAgreementFile, ...agreementRest } = state.agreement;
  void signedAgreementFile;
  return {
    step: state.step,
    status: state.status,
    lastSavedAt: state.lastSavedAt,
    dealerId: state.dealerId,
    dealerDisplayName: state.dealerDisplayName,
    internalApplicationId: state.internalApplicationId,
    draftApplicationId: state.draftApplicationId,
    company: {
      companyName: state.company.companyName,
      companyAddress: state.company.companyAddress,
      companyType: state.company.companyType,
      gstNumber: state.company.gstNumber,
      companyPanNumber: state.company.companyPanNumber,
      businessSummary: state.company.businessSummary,
    },
    ownership: {
      ownerName: state.ownership.ownerName,
      ownerPhone: state.ownership.ownerPhone,
      ownerLandline: state.ownership.ownerLandline,
      ownerEmail: state.ownership.ownerEmail,
      ownerAge: state.ownership.ownerAge,
      ownerAddressLine1: state.ownership.ownerAddressLine1,
      ownerCity: state.ownership.ownerCity,
      ownerDistrict: state.ownership.ownerDistrict,
      ownerState: state.ownership.ownerState,
      ownerPinCode: state.ownership.ownerPinCode,
      bankName: state.ownership.bankName,
      accountNumber: state.ownership.accountNumber,
      ifsc: state.ownership.ifsc,
      beneficiaryName: state.ownership.beneficiaryName,
      branch: state.ownership.branch,
      accountType: state.ownership.accountType,
      partners: (state.ownership.partners as Record<string, unknown>[]).map(
        stripRow
      ),
      directors: (state.ownership.directors as Record<string, unknown>[]).map(
        stripRow
      ),
    },
    finance: { ...state.finance },
    agreement: agreementRest,
    reviewChecks: { ...state.reviewChecks },
  };
}

function mergeOnboarding(
  persisted: unknown,
  current: DealerOnboardingState & StoreActions
): DealerOnboardingState & StoreActions {
  if (!persisted || typeof persisted !== "object") return current;
  const p = persisted as Record<string, any>;
  return {
    ...current,
    step: p.step ?? current.step,
    status: p.status ?? current.status,
    lastSavedAt: p.lastSavedAt ?? current.lastSavedAt,
    dealerId: p.dealerId ?? current.dealerId,
    dealerDisplayName: p.dealerDisplayName ?? current.dealerDisplayName,
    internalApplicationId:
      p.internalApplicationId ?? current.internalApplicationId,
    draftApplicationId: p.draftApplicationId ?? current.draftApplicationId,
    // Overlay persisted text onto fresh sections so upload slots (File/preview)
    // keep their valid runtime shape from initialState.
    company: { ...current.company, ...(p.company ?? {}) },
    compliance: current.compliance,
    ownership: {
      ...current.ownership,
      ...(p.ownership ?? {}),
      partners: Array.isArray(p.ownership?.partners)
        ? p.ownership.partners.map((row: Record<string, unknown>) => ({
            ...row,
            photo: makeUploadItem("Partner Photograph"),
          }))
        : current.ownership.partners,
      directors: Array.isArray(p.ownership?.directors)
        ? p.ownership.directors.map((row: Record<string, unknown>) => ({
            ...row,
            photo: makeUploadItem("Director Photograph"),
          }))
        : current.ownership.directors,
      // Upload-bearing slots are never persisted — keep the fresh ones.
      ownerPhoto: current.ownership.ownerPhoto,
      partnershipDeed: current.ownership.partnershipDeed,
      mouDocument: current.ownership.mouDocument,
      aoaDocument: current.ownership.aoaDocument,
    },
    finance: { ...current.finance, ...(p.finance ?? {}) },
    agreement: { ...current.agreement, ...(p.agreement ?? {}) },
    reviewChecks: { ...current.reviewChecks, ...(p.reviewChecks ?? {}) },
  };
}

export const useOnboardingStore = create<DealerOnboardingState & StoreActions>()(
  persist(
    (set, get) => ({
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

  // Pre-fill the wizard from an existing dealer_onboarding_applications row
  // (BRD §0.13). Used when an internal user opens the wizard for a converted
  // lead via /dealer-onboarding?applicationId=<id>. `app` is the raw API row,
  // `documents` its dealerOnboardingDocuments (empty on a fresh conversion).
  hydrateFromApplication: (app, documents) =>
    set((state) => {
      const a = (app ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string => (typeof v === "string" ? v : "");

      const paymentMethod = str(a.payment_method).toLowerCase();
      const enableFinance: DealerOnboardingState["finance"]["enableFinance"] =
        paymentMethod === "finance"
          ? "yes"
          : paymentMethod === "cash"
            ? "no"
            : "";

      // business_address is a text column but autosave stores a JSON-encoded
      // { address } object, while older rows hold a plain string — handle both.
      const businessAddress = a.business_address;
      let companyAddress = "";
      if (typeof businessAddress === "string") {
        const trimmed = businessAddress.trim();
        if (trimmed.startsWith("{")) {
          try {
            companyAddress =
              str((JSON.parse(trimmed) as Record<string, unknown>)?.address) ||
              "";
          } catch {
            companyAddress = trimmed;
          }
        } else {
          companyAddress = trimmed;
        }
      } else {
        companyAddress = str(
          (businessAddress as Record<string, unknown> | null)?.address
        );
      }

      const company: CompanyStepData = {
        ...state.company,
        companyName: str(a.company_name),
        companyType: str(
          a.company_type,
        ) as DealerOnboardingState["company"]["companyType"],
        gstNumber: str(a.gst_number),
        companyPanNumber: str(a.pan_number),
        companyAddress,
      };
      const compliance: ComplianceStepData = { ...state.compliance };

      // Re-attach any already-saved documents to their wizard upload slots
      // (none on a fresh conversion; populated after a prior submit).
      const docList = Array.isArray(documents)
        ? (documents as Array<Record<string, unknown>>)
        : [];
      for (const doc of docList) {
        const type = str(doc.document_type);
        const item: UploadFileItem = {
          ...makeUploadItem(type),
          uploadedUrl: str(doc.file_url) || null,
          storagePath: str(doc.storage_path) || null,
          bucketName: str(doc.bucket_name) || null,
          verificationState: "verified",
          progress: 100,
          uploadedAt: str(doc.uploaded_at) || new Date().toISOString(),
        };
        switch (type) {
          case "itr_3_years": compliance.itr3Years = item; break;
          case "bank_statement_3_months": compliance.bankStatement3Months = item; break;
          case "undated_cheques": compliance.undatedCheques = item; break;
          case "passport_photo": compliance.passportPhoto = item; break;
          case "udyam_certificate": compliance.udyamCertificate = item; break;
          case "gst_certificate": company.gstCertificate = item; break;
          case "pan_card": company.companyPanFile = item; break;
        }
      }

      // Resume on the step the draft was left on (E-160). Fall back to step 1
      // for legacy rows that predate draft_step.
      const savedStep = Number(a.draft_step);
      const resumeStep =
        Number.isFinite(savedStep) && savedStep >= 1 && savedStep <= 6
          ? Math.floor(savedStep)
          : 1;

      return {
        ...state,
        internalApplicationId: str(a.id) || null,
        draftApplicationId: str(a.id) || null,
        step: resumeStep,
        status: (str(a.onboarding_status) ||
          "draft") as DealerOnboardingState["status"],
        dealerId: str(a.dealer_code) || state.dealerId,
        dealerDisplayName: str(a.company_name) || state.dealerDisplayName,
        lastSavedAt: new Date().toISOString(),
        company,
        compliance,
        ownership: {
          ...state.ownership,
          ownerName: str(a.owner_name),
          ownerPhone: str(a.owner_phone),
          ownerEmail: str(a.owner_email),
          ownerLandline: str(a.owner_landline),
          ownerCity: str(a.city),
          ownerState: str(a.state),
          ownerPinCode: str(a.pincode),
          bankName: str(a.bank_name),
          accountNumber: str(a.account_number),
          ifsc: str(a.ifsc_code),
          beneficiaryName: str(a.beneficiary_name),
        },
        finance: {
          ...state.finance,
          enableFinance,
        },
        errors: {},
      };
    }),

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

  reset: () =>
    set({
      ...initialState,
      // Rebuild every upload slot so a new dealer never inherits the previous
      // dealer's file/preview references.
      company: {
        ...initialState.company,
        gstCertificate: makeUploadItem("GST Certificate"),
        companyPanFile: makeUploadItem("Company PAN"),
      },
      compliance: {
        itr3Years: makeUploadItem(
          "Last 3 Years Company Income Tax Returns"
        ),
        bankStatement3Months: makeUploadItem(
          "Last 3 Months Company Bank Statement"
        ),
        undatedCheques: makeUploadItem("4 Undated Cheques"),
        passportPhoto: makeUploadItem("Passport Size Photograph"),
        udyamCertificate: makeUploadItem("Udyam Registration Certificate"),
      },
      ownership: {
        ...initialState.ownership,
        ownerPhoto: makeUploadItem("Owner Photograph"),
        partnershipDeed: makeUploadItem("Partnership Deed"),
        mouDocument: makeUploadItem("MoU"),
        aoaDocument: makeUploadItem("AoA"),
        partners: [],
        directors: [],
      },
      agreement: createInitialAgreementState(),
      internalApplicationId: null,
      draftApplicationId: null,
      step: 1,
      status: "draft",
      lastSavedAt: null,
      dealerId: "",
      dealerDisplayName: "",
      errors: {},
    }),

  persistDraft: async () => {
    if (typeof window === "undefined") return;
    const state = get();
    // The save route rejects a draft with no company name (its only hard
    // requirement), so there is nothing to persist server-side until then —
    // the localStorage layer already covers that earlier window.
    if (!state.company.companyName?.trim()) return;
    if (state.status === "approved") return;

    try {
      const res = await fetch("/api/dealer-onboarding/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSavePayload(state)),
      });
      const json = await res.json().catch(() => null);
      const savedId: string | null =
        json?.application?.id ?? json?.data?.applicationId ?? null;

      if (json?.success && savedId) {
        if (savedId !== get().draftApplicationId) {
          set({
            draftApplicationId: savedId,
            lastSavedAt: new Date().toISOString(),
          });
          // Reflect the draft id in the URL so a refresh / reopened tab resumes
          // this exact dealer via OnboardingHydrator.
          const url = new URL(window.location.href);
          if (url.searchParams.get("applicationId") !== savedId) {
            url.searchParams.set("applicationId", savedId);
            window.history.replaceState(null, "", url.toString());
          }
        } else {
          set({ lastSavedAt: new Date().toISOString() });
        }
      }
    } catch (err) {
      console.error("[onboarding] autosave failed:", err);
    }
  },

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
    }),
    {
      name: "dealer-onboarding-draft",
      // SSR-safe storage: the thunk returns a no-op store on the server and the
      // real localStorage in the browser, so importing this module never throws
      // "localStorage is not defined" during a Next.js render.
      storage: createJSONStorage(() =>
        typeof window !== "undefined"
          ? window.localStorage
          : {
              getItem: () => null,
              setItem: () => {},
              removeItem: () => {},
            }
      ),
      version: 1,
      partialize: (state) =>
        partializeOnboarding(state) as unknown as DealerOnboardingState &
          StoreActions,
      merge: (persisted, current) =>
        mergeOnboarding(
          persisted,
          current as DealerOnboardingState & StoreActions
        ),
    }
  )
);

// ── Debounced autosave ───────────────────────────────────────────────────────
// Push the in-progress wizard to its server draft whenever its savable content
// changes. We diff the serialized save-payload so the store updates that
// persistDraft itself makes (internalApplicationId / lastSavedAt) don't form a
// feedback loop, and so noise like `errors` never triggers a network write.
if (typeof window !== "undefined") {
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPayloadSig = "";

  useOnboardingStore.subscribe((state) => {
    if (!state.company.companyName?.trim()) return;
    if (state.status === "approved") return;

    const sig = JSON.stringify(buildSavePayload(state));
    if (sig === lastPayloadSig) return;
    lastPayloadSig = sig;

    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      void useOnboardingStore.getState().persistDraft();
    }, 1200);
  });
}