import { requireRole } from "@/lib/auth-utils";
import { getTimeLimits } from "@/lib/timeLimits/store";
import { OnboardingDropoutsView } from "./_components/OnboardingDropoutsView";

export const dynamic = "force-dynamic";

// BRD §0.13 Point B — onboarding dropout loopback. Resolution is admin-only.
export default async function AdminOnboardingDropoutsPage() {
    const user = await requireRole(["admin", "sales_head", "ceo", "partner"]);
    // ID 85 — the drop-out and keep-waiting limits in force today.
    const limits = await getTimeLimits();

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    Onboarding Dropouts
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Won leads whose dealer onboarding was rejected, withdrawn or
                    has gone quiet for {limits.onboarding_dropout} days. Decide: keep
                    waiting (Stalled), flip to Lost, or re-engage.
                </p>
            </header>
            <OnboardingDropoutsView
                viewerRole={user.role}
                keepWaitingDays={limits.onboarding_keep_waiting}
            />
        </div>
    );
}
