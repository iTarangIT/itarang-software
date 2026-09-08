import { requireRole } from "@/lib/auth-utils";
import { DefaultLoanProductForm } from "../_components/DefaultLoanProductForm";

export const dynamic = "force-dynamic";

// E-282/E-283/E-286/E-289 — Settings → Loan Product. Its own route beside KYC Automation
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
                    every dealer in a location, to every customer living in a location,
                    or any combination. A matching applicant — on the dealer portal and
                    over WhatsApp alike — is shown that one product instead of the full
                    list of lenders who cover them. Every field you leave blank means
                    &ldquo;any&rdquo;: a rule with only a dealer covers all of that
                    dealer&apos;s customers wherever that dealer is, a rule with only a
                    dealer state covers every dealer registered in it, and a rule with
                    only a customer city covers everyone who lives there, whichever
                    dealer they walked into. Pick several cities at once to pin the same
                    product across all of them — one rule is saved per city, so each can
                    be re-pointed or removed on its own later.
                </p>
                <p className="mt-2 text-sm text-ink-muted">
                    When more than one rule matches, the highest <strong>priority</strong>
                    wins. On a tie, the rule that pins down more fields wins — so
                    &ldquo;this dealer, customers in Pune&rdquo; is checked before either
                    &ldquo;this dealer&rdquo; or &ldquo;customers in Pune&rdquo;. Rules
                    that name the same number of fields fall back to a fixed order:
                    dealer, customer city, customer state, dealer city, dealer state.
                </p>
                <p className="mt-2 text-sm text-ink-muted">
                    The two locations are different things.{" "}
                    <strong>Dealer state and city</strong> are the dealer&apos;s own
                    registered address, so those lists offer only places you actually
                    have dealers in. <strong>Customer state and city</strong> are where
                    the applicant lives, taken from the address on their lead — captured
                    in Step 1 on the portal, or read from their Aadhaar and address proof
                    on WhatsApp. A WhatsApp lead whose documents have not been read yet
                    has no address, so it matches no customer rule and falls through.
                </p>
                <p className="mt-2 text-sm text-ink-muted">
                    None of this widens who a lender can serve. The{" "}
                    <strong>serviceable locations</strong> set on the loan product itself
                    remain the lender&apos;s own declaration of where it operates, and
                    they are applied first — pinning a product somewhere it does not
                    serve simply means the rule never fires.
                </p>
                <p className="mt-2 text-sm text-ink-muted">
                    A default is only offered when it actually fits the customer. If the
                    requested loan amount is above the product&apos;s maximum, the battery
                    category does not apply, the lender does not serve where the customer
                    lives, or it cannot serve that dealer, the next matching rule is
                    tried — and if none fit, the applicant sees the normal matched list
                    instead.
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
