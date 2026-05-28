import { requireRole } from "@/lib/auth-utils";
import { OnboardingDropoutsView } from "./_components/OnboardingDropoutsView";

export const dynamic = "force-dynamic";

// BRD §0.13 Point B — onboarding dropout loopback. Resolution is admin-only.
export default async function AdminOnboardingDropoutsPage() {
    const user = await requireRole(["admin", "sales_head", "ceo"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    Onboarding Dropouts
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Converted leads whose dealer onboarding was rejected,
                    withdrawn, or has stalled. Keep Converted, Flip to Lost, or
                    Re-engage.
                </p>
            </header>
            <OnboardingDropoutsView viewerRole={user.role} />
        </div>
    );
}
