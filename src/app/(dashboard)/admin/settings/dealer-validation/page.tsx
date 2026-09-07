import { requireRole } from "@/lib/auth-utils";
import { digestKind } from "@/lib/digests/registry";
import { DigestSettingsForm } from "../_components/DigestSettingsForm";

export const dynamic = "force-dynamic";

// E-287/E-288 — one digest's settings, on its own route so it can be its own
// sidebar entry beside KYC Automation rather than a tab inside Notifications.
//
// Deliberately NOT a tab on Settings → Notifications: that screen governs which
// notification TYPES the generic emit() mailer also sends by email. A digest is a
// scheduled summary with no notification type behind it — a bespoke sender, like
// the ~16 others in src/lib/email/ — so a toggle on that grid could never reach
// it.
//
// Same gate as /admin/settings: middleware admits `ceo` to /admin but this does
// not, matching every other settings screen in this folder.
const KIND = "dealer_validation";

export default async function DigestSettingsPage() {
    await requireRole(["admin", "sales_head"]);

    // Heading text comes from the descriptor, so it cannot drift from the mail.
    const kind = digestKind(KIND);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1100px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    {kind?.label ?? "Digest"}
                </h1>
                <p className="mt-1 text-sm text-ink-muted">{kind?.description}</p>
            </header>

            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="p-5">
                    <DigestSettingsForm kind={KIND} />
                </div>
            </div>
        </div>
    );
}
