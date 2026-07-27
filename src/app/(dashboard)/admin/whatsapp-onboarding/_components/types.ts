// Shared shapes for the admin WhatsApp-onboarding console (E-214).

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
