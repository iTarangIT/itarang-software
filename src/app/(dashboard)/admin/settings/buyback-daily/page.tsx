import { requireRole } from "@/lib/auth-utils";
import { digestKind } from "@/lib/digests/registry";
import { DigestSettingsForm } from "../_components/DigestSettingsForm";

export const dynamic = "force-dynamic";

// B9 — the Buyback Daily digest's settings, on its own route like the other
// digests (see kyc-review/page.tsx for why it is not a Notifications tab).
const KIND = "buyback_daily";

export default async function DigestSettingsPage() {
    await requireRole(["admin", "sales_head"]);

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
