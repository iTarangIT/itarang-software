import { canManageAccounts } from "@/lib/accounts/access";
import { requireRole } from "@/lib/auth-utils";
import { DealerHealthView } from "./DealerHealthView";

export const dynamic = "force-dynamic";

// R-18 — converted dealers' re-order health (Requirements #5, #41).
export default async function DealerHealthPage() {
    const user = await requireRole(["admin", "ceo", "sales_head", "business_head", "partner"]);

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1500px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Dealer Health</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Every activated dealer account by how recently it last ordered. Orders are its
                    invoices, matched on the account&apos;s GSTIN (or the originating lead&apos;s while
                    the account&apos;s is missing). Orange is the time to pitch; Red means billing must
                    happen.
                </p>
            </header>
            <DealerHealthView canManageAccounts={canManageAccounts(user.role)} />
        </div>
    );
}
