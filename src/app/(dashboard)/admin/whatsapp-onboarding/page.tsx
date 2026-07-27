import { requireRole } from "@/lib/auth-utils";
import { WhatsAppOperatorsView } from "./_components/WhatsAppOperatorsView";

export const dynamic = "force-dynamic";

// E-214 — the internal WhatsApp onboarding team. Each operator onboards MANY
// dealers from their own single WhatsApp number. Read is open to admin /
// sales_head / ceo; the mutating APIs are tighter (admin + sales_head), so ceo
// is effectively read-only here.
export default async function AdminWhatsAppOnboardingPage() {
    const user = await requireRole(["admin", "sales_head", "ceo"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    WhatsApp Onboarding
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Internal team members who onboard dealers over WhatsApp. Each
                    number below can run many dealer files at once — add a
                    number, watch their pipeline, and read any conversation.
                </p>
            </header>
            <WhatsAppOperatorsView viewerRole={user.role} />
        </div>
    );
}
