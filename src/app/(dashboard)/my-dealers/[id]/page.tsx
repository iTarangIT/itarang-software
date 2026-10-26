import { requireRole } from "@/lib/auth-utils";
import { ACCOUNT_QUOTE_VIEW_ROLES } from "@/lib/accounts/quotationAccess";
import { AccountPageView } from "./AccountPageView";

export const dynamic = "force-dynamic";

// E-356 — one dealer account from My Dealers: its details and its account
// quotations. Who may open it and who may raise a quotation is decided per
// account by the API (src/lib/accounts/quotationAccess.ts).
export default async function MyDealerAccountPage({ params }: { params: Promise<{ id: string }> }) {
    await requireRole([...ACCOUNT_QUOTE_VIEW_ROLES]);
    const { id } = await params;
    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1100px]">
            <AccountPageView accountId={decodeURIComponent(id)} />
        </div>
    );
}
