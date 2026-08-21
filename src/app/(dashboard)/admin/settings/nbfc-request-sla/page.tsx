import { requireRole } from "@/lib/auth-utils";
import { NbfcRequestSlaForm } from "../_components/NbfcRequestSlaForm";

export const dynamic = "force-dynamic";

// E-254 — NBFC request SLA, on its own route beside KYC Automation for the
// same reason that one is: its own sidebar entry rather than a tab.
// Same gate as /admin/settings/kyc-automation.
export default async function NbfcRequestSlaSettingsPage() {
    await requireRole(["admin", "sales_head"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1100px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    NBFC Request SLA
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    When an NBFC asks iTarang for a correction or extra documents, the
                    request waits this long for someone here to route it. If nobody does,
                    the system forwards it to the dealer — and once the dealer has uploaded,
                    it waits again for a review before pushing the documents back to the
                    NBFC on its own.
                </p>
            </header>

            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="p-5">
                    <NbfcRequestSlaForm />
                </div>
            </div>
        </div>
    );
}
