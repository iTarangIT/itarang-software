import { requireRole } from "@/lib/auth-utils";
import { SettingsView } from "./_components/SettingsView";

export const dynamic = "force-dynamic";

// Admin-only configuration. Now just per-dashboard notification access (E-231):
// KYC auto-approval (E-242) has its own route at /admin/settings/kyc-automation
// and its own sidebar entry. The BRD §0.11/§0.12 tabs for assignment rules, the
// holiday calendar and ASM territory mapping were removed from the tab strip on
// request — see the note in SettingsView for what still exists behind them.
//
// NOTE middleware admits `ceo` to /admin but this gate does not, so a CEO who
// clicks through gets a 403. That predates E-231 and is left alone deliberately.
// The original reason not to widen it was that "ceo" would also unlock
// Assignment Config and ASM Territories; those are gone, so if you do want CEOs
// on this page, adding them here now only grants Notification Access — which
// editableDashboardsFor() already treats as a full-scope role.
export default async function AdminSettingsPage() {
    await requireRole(["admin", "sales_head"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1100px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    Notifications
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Which notifications reach which dashboard.
                </p>
            </header>
            <SettingsView />
        </div>
    );
}
