import { requireRole } from "@/lib/auth-utils";
import { AccountDetailView } from "../_components/AccountDetailView";

export const dynamic = "force-dynamic";

// Tracker P1-1 / P1-2 — one dealer account: owner + history, GSTIN correction.
export default async function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
    await requireRole(["admin", "ceo"]);
    const { id } = await params;

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 max-w-[1200px]">
            <AccountDetailView accountId={decodeURIComponent(id)} />
        </div>
    );
}
