import { requireRole } from "@/lib/auth-utils";
import { PartnerQuotationsView } from "./_components/PartnerQuotationsView";

export const dynamic = "force-dynamic";

// "My Quotations (PI)" — every PI the partner raised and where it stands.
// The CEO decides in the existing queue; this is the raiser's view of the
// outcome, which until now existed only by opening each lead one at a time.
export default async function PartnerQuotationsPage() {
    const user = await requireRole(["partner", "admin", "ceo"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1600px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                    My Quotations (PI)
                </h1>
                <p className="mt-1 text-sm text-gray-600">
                    {user.name}, these are the proforma invoices you raised. Quotes at or above
                    the OEM reference price release themselves; the rest wait for the CEO.
                </p>
            </header>
            <PartnerQuotationsView />
        </div>
    );
}
