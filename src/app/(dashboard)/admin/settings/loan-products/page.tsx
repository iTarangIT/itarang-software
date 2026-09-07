import { requireRole } from "@/lib/auth-utils";
import { DefaultLoanProductForm } from "../_components/DefaultLoanProductForm";

export const dynamic = "force-dynamic";

// E-280/E-281/E-284 — Settings → Loan Product. Its own route beside KYC Automation
// and NBFC Request SLA for the same reason those are: a distinct concern rather
// than a tab. Same gate as its siblings.
export default async function LoanProductDefaultsSettingsPage() {
    await requireRole(["admin", "sales_head"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1100px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    Loan Product
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Pin the lender and loan product offered by default by a dealer, by
                    every dealer in a location, or both. A matching applicant — on the dealer portal and
                    over WhatsApp alike — is shown that one product instead of the full
                    list of lenders who cover them. Every field you leave blank means
                    &ldquo;any&rdquo;: a rule with only a dealer covers all of that
                    dealer&apos;s customers wherever that dealer is, and a rule with only
                    a state covers every dealer registered in it. Pick several cities at once to pin the same
                    product across all of them — one rule is saved per city, so each can
                    be re-pointed or removed on its own later.
                </p>
                <p className="mt-2 text-sm text-ink-muted">
                    When more than one rule matches, the highest <strong>priority</strong>
                    wins. On a tie, the more specific rule wins: a dealer rule beats a
                    location-only rule, and an exact city beats a whole state.
                </p>
                <p className="mt-2 text-sm text-ink-muted">
                    The state and city here are the <strong>dealer&apos;s</strong> own
                    registered address, not the customer&apos;s — so the lists offer only
                    places you actually have dealers in. Where the customer lives is still
                    handled separately, by the serviceable locations set on the loan
                    product itself.
                </p>
                <p className="mt-2 text-sm text-ink-muted">
                    A default is only offered when it actually fits the customer. If the
                    requested loan amount is above the product&apos;s maximum, the battery
                    category does not apply, or the lender cannot serve that dealer, the
                    next matching rule is tried — and if none fit, the applicant sees the
                    normal matched list instead.
                </p>
            </header>

            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="p-5">
                    <DefaultLoanProductForm />
                </div>
            </div>
        </div>
    );
}
