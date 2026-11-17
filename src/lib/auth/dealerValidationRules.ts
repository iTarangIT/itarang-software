// Who may READ the Dealer Validation page (/admin/dealer-verification and
// /api/admin/dealer-verifications/**) — tracker ID 166 item 11, 18 Oct.
//
// The rule for files and dealer papers: Admin, the Sales Head, the CEO and the
// owner of the dealer account. Before this the page was Sales Head and CEO
// only, so Admin and the account's owner were refused papers they may open
// everywhere else. The ACTIONS (approve, reject, corrections, agreement
// steps) stay with the Sales Head and the CEO (requireSalesHead).
//
// Pure: no db imports, so it unit-tests alone. requireSalesHead.ts loads the
// facts and applies it.

/** Read every application, and the queue / summary / export. */
export const DEALER_VALIDATION_ALL_ROLES = ["sales_head", "ceo", "admin"] as const;

/**
 * Roles that read an application only when they own it. The roles an account
 * can be owned by (ASSIGNABLE_OWNER_ROLES in src/app/api/admin/accounts/_lib.ts,
 * minus sales_head which reads all) — except the ASM and the ISR: 17 Nov
 * (user) they do not open Dealer Validation at all, not even their own
 * applications (page and every API refuse them).
 */
export const DEALER_VALIDATION_OWNER_ROLES = [
    "sales_executive",
    "sales_manager",
    "business_head",
] as const;

/** Everyone middleware lets onto the page; the API narrows owners to their own. */
export const DEALER_VALIDATION_PAGE_ROLES = [...DEALER_VALIDATION_ALL_ROLES, ...DEALER_VALIDATION_OWNER_ROLES] as const;

export type DealerValidationScope = "all" | "own" | "none";

export function dealerValidationScope(role: string | null | undefined): DealerValidationScope {
    const r = (role ?? "").toLowerCase();
    if ((DEALER_VALIDATION_ALL_ROLES as readonly string[]).includes(r)) return "all";
    if ((DEALER_VALIDATION_OWNER_ROLES as readonly string[]).includes(r)) return "own";
    return "none";
}

/**
 * Does this user own the dealer application? The iTarang owner of the account
 * it became (account_ownership.owner_user_id), the salesperson on the form
 * (salesperson_user_id) or the owner the dealer lead carried in (owner_id).
 * A missing fact is a refusal.
 */
export function ownsDealerApplication(
    userId: string | null | undefined,
    owners: { accountOwnerId?: string | null; salespersonUserId?: string | null; ownerId?: string | null },
): boolean {
    const me = (userId ?? "").trim();
    if (!me) return false;
    return [owners.accountOwnerId, owners.salespersonUserId, owners.ownerId].some((o) => !!o && o === me);
}

/** May this user read this application on the Dealer Validation page? */
export function mayReadDealerApplication(input: {
    role: string | null | undefined;
    userId: string | null | undefined;
    accountOwnerId?: string | null;
    salespersonUserId?: string | null;
    ownerId?: string | null;
}): boolean {
    const scope = dealerValidationScope(input.role);
    if (scope === "all") return true;
    if (scope === "none") return false;
    return ownsDealerApplication(input.userId, input);
}

/**
 * May this user open an application in the onboarding wizard
 * (/dealer-onboarding?applicationId=… → GET /api/dealer-onboarding/[id], which
 * returns the application and every uploaded document)?
 *
 * - Admin, Sales Head, CEO: any application.
 * - ASM / ISR: only while it is still a draft they are filling in (any draft,
 *   so a converted lead's form can be continued by its owner). 17 Nov (user):
 *   once submitted it is a Dealer Validation file, which they do not open —
 *   not even one they created.
 * - Anyone else (the dealer, the onboarding role): only their own application.
 */
export const ONBOARDING_WIZARD_ALL_ROLES = ["admin", "sales_head", "ceo"] as const;
export const ONBOARDING_WIZARD_DRAFT_ROLES = ["asm", "inside_sales_rep"] as const;

export function mayOpenOnboardingApplication(input: {
    role: string | null | undefined;
    userId: string | null | undefined;
    dealerUserId?: string | null;
    onboardingStatus?: string | null;
}): boolean {
    const r = (input.role ?? "").toLowerCase();
    if ((ONBOARDING_WIZARD_ALL_ROLES as readonly string[]).includes(r)) return true;
    if ((ONBOARDING_WIZARD_DRAFT_ROLES as readonly string[]).includes(r)) {
        return (input.onboardingStatus ?? "").toLowerCase() === "draft";
    }
    const me = (input.userId ?? "").trim();
    return !!me && input.dealerUserId === me;
}
