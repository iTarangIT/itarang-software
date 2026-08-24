import { requireRole } from "@/lib/auth-utils";
import { ScrapPaymentTermsForm } from "../_components/ScrapPaymentTermsForm";

export const dynamic = "force-dynamic";

// E-259 — Settings → NBFC → Payments. Same gate as the neighbouring NBFC
// settings screens: choosing the terms a counterparty trades on is a
// commercial decision, distinct from releasing a payment under them (which
// stays admin/ceo on the Scrap Purchase desk).
export default async function NbfcPaymentsSettingsPage() {
    await requireRole(["admin", "sales_head"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1100px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    NBFC Payments
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    When iTarang pays each NBFC for the scrap batteries it buys from
                    them. Pre-lot releases the money once the rate is agreed, before
                    the batteries are collected; post-lot holds the payout until an
                    admin has marked the consignment received. Every NBFC starts on
                    post-lot until somebody decides otherwise.
                </p>
            </header>

            <section className="rounded-xl border border-border bg-surface shadow-card">
                <div className="border-b border-border px-5 py-3">
                    <h2 className="text-sm font-semibold text-ink">
                        Scrap battery payments
                    </h2>
                    <p className="text-xs text-ink-muted">
                        Applies to consignments bought through Scrap Purchase.
                    </p>
                </div>
                <div className="p-5">
                    <ScrapPaymentTermsForm />
                </div>
            </section>
        </div>
    );
}
