import { requireRole } from "@/lib/auth-utils";
import NbfcRoutingRules from "./NbfcRoutingRules";

export const dynamic = "force-dynamic";

// E-391 — Battery Pool diagram 1, part 2: NBFC routing rules.
export default async function NbfcRoutingRulesPage() {
  await requireRole(["admin", "sales_head"]);
  return (
    <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1150px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">NBFC routing rules</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Send an application straight to one NBFC — by dealer, customer state / city and product category, in any mix.
          When Step 4 opens (KYC approved, and the dealer check approved where one is needed) and a rule fits, the file
          goes to that NBFC automatically: no lender list for the dealer or the customer.
        </p>
        <p className="mt-2 text-sm text-ink-muted">
          <strong>The most specific rule wins</strong> — a dealer counts most, then city, then state, then category.
          A rule only fires when its loan product also passes the NBFC&apos;s own eligibility for that lead (location,
          battery category, loan amount, dealer not blocked). Otherwise the dealer gets the usual lender choice, where
          the Loan Product pins still apply.
        </p>
      </header>
      <NbfcRoutingRules />
    </div>
  );
}
