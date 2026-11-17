// Lost reasons in words, for reading (dashboards, CEO pages, downloads, emails): ID 215.
// The Mark Lost form keeps its own labels with instructions ("Other (notes required)");
// this is the plain name. The stored codes never change. Client-safe.

import type { LostReason } from "@/lib/lifecycle/transitions";

export const LOST_REASON_WORDS: Readonly<Record<LostReason, string>> = Object.freeze({
    not_interested: "Not interested",
    price_high: "Price too high",
    bad_experience_with_trontek: "Bad experience with Trontek",
    loan_procedure_issue: "Loan procedure issue",
    business_closed: "Business closed",
    non_operational_location: "Non-operational location",
    rejected_by_us_credit: "Rejected by us: credit",
    rejected_by_us_geography: "Rejected by us: geography",
    duplicate_lead: "Duplicate lead",
    other: "Other",
    invalid_contact: "Number not working",
    onboarding_dropout: "Onboarding dropout",
    onboarding_rejected: "Onboarding rejected",
    lost_to_competition: "Lost to competition",
    moved_to_other_business: "Moved to other business",
    test_lead: "Test lead",
});

/** "price_high" → "Price too high"; an unknown code still reads as words; blank stays blank. */
export function lostReasonWords(code: string | null | undefined): string {
    if (!code) return "";
    const known = (LOST_REASON_WORDS as Record<string, string>)[code];
    if (known) return known;
    const s = code.replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
}
