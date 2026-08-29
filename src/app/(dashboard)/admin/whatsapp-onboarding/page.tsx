import { Suspense } from "react";
import { requireRole } from "@/lib/auth-utils";
import { WhatsAppOnboardingTabs } from "./_components/WhatsAppOnboardingTabs";

export const dynamic = "force-dynamic";

// Everything that happens on the WhatsApp onboarding number, in one place:
//
//  • Live conversations — every contact from their very first message, whether
//    or not they ever finish. The Dealer Verification queue deliberately hides
//    unfinished applications (an admin can't approve a draft), which used to
//    mean an in-progress prospect was invisible CRM-wide until they submitted.
//  • Customer leads — leads a dealer started over WhatsApp but hasn't sent in.
//  • Onboarding team — the E-214 operator allowlist and their pipelines.
//
// Read is open to admin / sales_head / ceo; the mutating operator APIs are
// tighter (admin + sales_head), so ceo is effectively read-only here.
export default async function AdminWhatsAppOnboardingPage() {
    const user = await requireRole(["admin", "sales_head", "ceo"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    WhatsApp Onboarding
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Every conversation on the onboarding number, from the first
                    message — including contacts who have only said hi, and
                    dealers who have sent some documents but not submitted yet.
                </p>
            </header>

            <Suspense
                fallback={
                    <div className="py-10 text-sm text-ink-muted">Loading…</div>
                }
            >
                <WhatsAppOnboardingTabs viewerRole={user.role} />
            </Suspense>
        </div>
    );
}
