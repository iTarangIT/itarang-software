import { requireRole } from "@/lib/auth-utils";
import { SettingsView } from "./_components/SettingsView";

export const dynamic = "force-dynamic";

// BRD §0.11/§0.12 — admin-only configuration: assignment rules, holiday
// calendar, ASM territory mapping, and per-dashboard notification access (E-231).
//
// NOTE middleware admits `ceo` to /admin but this gate does not, so a CEO who
// clicks through gets a 403. That predates E-231 and is left alone deliberately:
// adding "ceo" here would also hand them Assignment Config and ASM Territories,
// which is a scope decision, not a bug fix.
export default async function AdminSettingsPage() {
    await requireRole(["admin", "sales_head"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1100px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    Settings
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Assignment rules, the working-day holiday calendar, ASM
                    territory mapping, and which notifications reach which
                    dashboard.
                </p>
            </header>
            <SettingsView />
        </div>
    );
}
