import { requireRole } from "@/lib/auth-utils";
import { DefaultLoanProductForm } from "../_components/DefaultLoanProductForm";

export const dynamic = "force-dynamic";

// E-282/E-283/E-286/E-290/E-291 — Settings → Loan Product. Its own route beside KYC Automation
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
                    Pin the lender and loan product offered by default — to one
                    dealer, or to every customer in a city or state. A matching
                    applicant — on the dealer portal and over WhatsApp alike — is
                    shown that one product instead of the full list of lenders who
                    cover them.
                </p>
                <p className="mt-2 text-sm text-ink-muted">
                    <strong>The most specific rule wins: dealer, then city, then
                    state.</strong> So a rule for one dealer beats a rule for the
                    city its customer lives in, which in turn beats a rule for the
                    state. The location is the <strong>customer&apos;s own
                    address on the lead</strong>, so you may pin a city before the
                    first lead from it ever arrives. Pick several cities at once to
                    pin the same product across all of them — one rule is saved
                    per city, so each can be re-pointed or removed on its own
                    later.
                </p>
                <p className="mt-2 text-sm text-ink-muted">
                    None of this widens who a lender can serve. The{" "}
                    <strong>serviceable locations</strong> set on the loan product
                    itself remain the lender&apos;s own declaration of where it
                    operates, and they are applied first — so a rule naming a city
                    no lender covers is simply never offered, rather than forcing a
                    lender into it.
                </p>
                <p className="mt-2 text-sm text-ink-muted">
                    A default is only offered when it actually fits the customer. If
                    the requested loan amount is above the product&apos;s maximum, the
                    battery category does not apply, the lender does not serve where
                    the customer lives, or it cannot serve that dealer, the next
                    matching rule is tried — and if none fit, the applicant sees the
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
