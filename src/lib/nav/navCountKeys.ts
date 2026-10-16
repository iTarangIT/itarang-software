// ID 90 — the left menu's waiting counts: which queue feeds which menu item.
// CLIENT-SAFE (no database import): /api/admin/nav-counts answers by queue key
// and useNavCounts puts each number on every menu id below. The menu ids are
// the ones sidebar.tsx defines; each role has its own spelling of some rows
// (`sh-…`, `admin-…`, `ceo-…`), and a role simply lacks the ids it has no row for.

export const NAV_COUNT_IDS = {
    /** Sales Head / Business Head approvals queue. */
    approvals: ["approvals"],
    escalations: ["sh-escalations", "admin-escalations", "ceo-escalations"],
    readyToAssign: ["sh-ready-to-assign", "admin-ready-to-assign", "ceo-ready-to-assign"],
    productReview: ["product-review"],
    kycReview: ["kyc-review"],
    dealerValidation: ["dealer-validation"],
    whatsappOnboarding: ["sh-whatsapp-onboarding", "admin-whatsapp-onboarding"],
    // Lead clean-up folder.
    needsAttention: ["sh-needs-attention", "admin-needs-attention", "ceo-needs-attention"],
    mergeRequests: ["sh-merge-requests", "admin-merge-requests"],
    numberRepair: ["sh-number-repair", "admin-number-repair", "ceo-number-repair"],
    onboardingDropouts: ["sh-onboarding-dropouts", "admin-onboarding-dropouts"],
    // CEO decisions.
    expenseApprovals: ["expense-approvals"],
    financingApprovals: ["financing-offer-approvals"],
} as const satisfies Record<string, readonly string[]>;

export type NavCountKey = keyof typeof NAV_COUNT_IDS;
export type NavCounts = Partial<Record<NavCountKey, number>>;
