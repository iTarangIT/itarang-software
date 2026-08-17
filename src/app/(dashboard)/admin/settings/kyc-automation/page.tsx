import { requireRole } from "@/lib/auth-utils";
import { KycAutomationForm } from "../_components/KycAutomationForm";

export const dynamic = "force-dynamic";

// E-242 — KYC auto-approval, on its own route so it can be its own sidebar
// entry beside Notifications rather than a tab inside it.
//
// Same gate as /admin/settings: middleware admits `ceo` to /admin but this does
// not, so a CEO who clicks through gets a 403. That predates E-242 and is left
// alone deliberately — widening it here would hand CEOs a switch that accepts
// identity documents without calling the verification providers.
export default async function KycAutomationSettingsPage() {
    await requireRole(["admin", "sales_head"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1100px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    KYC Automation
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    When a dealer submits documents and the coupon, the case waits this
                    long for someone to review it. If nobody does, the system clears it so
                    the dealer is not left blocked.
                </p>
            </header>

            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="p-5">
                    <KycAutomationForm />
                </div>
            </div>
        </div>
    );
}
