import { requireRole } from "@/lib/auth-utils";
import { InvoiceLedgerView } from "./InvoiceLedgerView";

export const dynamic = "force-dynamic";

// E-322 (tracker IDs 39, 71) — weekly Vyapar sales-register / GSTR-1 import,
// Vyapar item → product mapping, units by SKU, monthly GSTR-1 reconciliation.
export default async function InvoiceLedgerPage() {
    await requireRole(["admin", "ceo", "finance_controller"]);

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1500px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Invoice Ledger</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Import the weekly Vyapar sales register (lines, HSN, quantity, cancellations) and the
                    filed GSTR-1. Batteries sold are counted from invoice lines (HSN 8507). Void an invoice
                    or record a payment from Sales Invoices.
                </p>
            </header>
            <InvoiceLedgerView />
        </div>
    );
}
