// Shared shapes for the admin WhatsApp-onboarding console (E-214).

import type { ContactType, WaActivity, WaStage } from "@/lib/whatsapp/stage";
import type { CapturedField } from "@/lib/whatsapp/captured-details";

export type OperatorCounts = {
    draft: number;
    submitted: number;
    approved: number;
    rejected: number;
    total: number;
};

export type OperatorRow = {
    id: string;
    waPhone: string;
    displayName: string;
    email: string | null;
    userId: string | null;
    isActive: boolean;
    notes: string | null;
    createdAt: string;
    deactivatedAt: string | null;
    counts: OperatorCounts;
};

export type PipelineFile = {
    applicationId: string;
    companyName: string | null;
    ownerName: string | null;
    dealerPhone: string | null;
    onboardingStatus: string | null;
    reviewStatus: string | null;
    /** 'self' | 'operator' | 'operator_handoff' */
    channel: string | null;
    dealerCode: string | null;
    financeEnabled: boolean | null;
    createdAt: string;
    updatedAt: string;
    handoffAt: string | null;
    /** The operator's own per-dealer conversation. */
    operatorSessionId: string | null;
    operatorState: string | null;
    operatorLastInbound: string | null;
    /** The dealer's own conversation, once they've been invited. */
    dealerSessionId: string | null;
    dealerState: string | null;
    dealerLastInbound: string | null;
};

export type TranscriptTarget = {
    sessionId: string;
    title: string;
    subtitle: string;
};

// ── Live conversations (every WhatsApp contact, from the first message) ──────

export type MissingDoc = { type: string; label: string };

export type LiveConversation = {
    applicationId: string;
    /** Dealer vs customer vs still-undecided — see contactTypeOf(). */
    contactType: ContactType;
    contactTypeLabel: string;
    /** Resolved server-side — never the "(pending)" placeholder. */
    displayName: string;
    companyName: string | null;
    contactName: string | null;
    ownerName: string | null;
    ownerPhone: string | null;
    ownerEmail: string | null;
    waPhone: string | null;
    companyType: string | null;
    dealerType: string | null;
    gstNumber: string | null;
    panNumber: string | null;
    city: string | null;
    state: string | null;

    stage: WaStage;
    stageLabel: string;
    currentState: string | null;
    activity: WaActivity;

    docsUploaded: number;
    docsRequired: number;
    missingDocuments: MissingDoc[];
    chatAnswers: number;

    onboardingStatus: string | null;
    reviewStatus: string | null;
    submittedAt: string | null;
    dealerCode: string | null;
    financeEnabled: boolean | null;
    warningCount: number;

    /** 'self' | 'operator' | 'operator_handoff' */
    channel: string;
    operatorName: string | null;
    firstContactAt: string;
    lastInboundAt: string | null;
    lastActivityAt: string;
    sessionStatus: string | null;
    /** More than one application on this WhatsApp number — shown, never merged. */
    duplicateOnPhone: boolean;

    dealerSessionId: string | null;
    operatorSessionId: string | null;
};

export type ConversationSummary = {
    total: number;
    inProgress: number;
    byStage: Partial<Record<WaStage, number>>;
    byType: Partial<Record<ContactType, number>>;
};

export type ConversationDocument = {
    id: string;
    documentType: string;
    label: string;
    fileUrl: string | null;
    fileName: string | null;
    mimeType: string | null;
    fileSize: number | null;
    docStatus: string | null;
    verificationStatus: string | null;
    uploadedAt: string;
    extractedFields: Record<string, unknown>;
    extractionConfidence: string | number | null;
    verificationProvider: string | null;
    source: string | null;
};

export type ConversationSession = {
    id: string;
    kind: string;
    waPhone: string;
    waContactName: string | null;
    currentState: string;
    sessionStatus: string;
    language: string;
    detectedCompanyType: string | null;
    expectedDocumentType: string | null;
    createdAt: string;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    role: "operator" | "dealer";
};

export type ConversationDetail = {
    application: {
        applicationId: string;
        contactType: ContactType;
        contactTypeLabel: string;
        displayName: string;
        companyName: string | null;
        companyType: string | null;
        dealerType: string | null;
        waPhone: string | null;
        onboardingStatus: string | null;
        reviewStatus: string | null;
        agreementStatus: string | null;
        dealerCode: string | null;
        financeEnabled: boolean | null;
        channel: string;
        firstContactAt: string;
        submittedAt: string | null;
        approvedAt: string | null;
        lastInboundAt: string | null;
        activity: WaActivity;
        stage: WaStage;
        stageLabel: string;
        currentState: string | null;
        operator: { id: string; displayName: string; waPhone: string } | null;
        warnings: unknown[];
        extractionSummary: unknown;
    };
    sessions: ConversationSession[];
    captured: CapturedField[];
    documents: ConversationDocument[];
    checklist: Array<{ type: string; label: string; uploaded: boolean }>;
    progress: {
        stage: WaStage;
        stageLabel: string;
        docsUploaded: number;
        docsRequired: number;
    };
    skipped: MissingDoc[];
};

// ── Partial customer leads (dealer started a lead, never submitted it) ───────

export type PartialCustomerLead = {
    leadId: string;
    customerName: string;
    hasName: boolean;
    mobile: string | null;
    dealerCode: string | null;
    dealerName: string | null;
    /** E-277 — the dealer's salesperson who created this lead, when any. */
    salespersonName?: string | null;
    interest: string | null;
    paymentMethod: string | null;
    consentStatus: string | null;
    kycStatus: string | null;
    leadStatus: string | null;
    assetModel: string | null;
    city: string | null;
    state: string | null;
    docsUploaded: number;
    docTypes: string[];
    createdAt: string;
    updatedAt: string;
};
