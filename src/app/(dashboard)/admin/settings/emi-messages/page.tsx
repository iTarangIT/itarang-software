import { requireRole } from "@/lib/auth-utils";
import { EmiMessagesForm } from "../_components/EmiMessagesForm";

export const dynamic = "force-dynamic";

// ID 204 — EMI follow-up and "EMI received" messages to the customer of a
// financed file (WhatsApp + SMS, Hindi), piloted on one lender. Same gate as
// the other NBFC settings.
export default async function EmiMessagesSettingsPage() {
    await requireRole(["admin", "sales_head"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1100px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">EMI messages</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Messages to the customer of a financed file: EMI due in a few days, due today, overdue, and
                    &quot;EMI received&quot; on every recorded payment — on WhatsApp and SMS, in Hindi. Each goes once per
                    EMI, and only while it is unpaid. Pilot on one lender. Meta and DLT approve the exact text, so an
                    edited text is held until you mark it approved.
                </p>
            </header>
            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="p-5">
                    <EmiMessagesForm />
                </div>
            </div>
        </div>
    );
}
