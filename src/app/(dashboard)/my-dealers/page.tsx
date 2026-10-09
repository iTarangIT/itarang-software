import { requireRole } from "@/lib/auth-utils";
import { MY_DEALERS_PAGE_ROLES } from "@/lib/auth/staffPageRoles";
import { MyDealersView } from "./MyDealersView";

export const dynamic = "force-dynamic";

// Tracker ID 5 — the dealer accounts the signed-in user owns, by how long since
// each last ordered, with "Order placed" for an order whose invoice is not
// raised yet. The reorder reminder emails link here.
export default async function MyDealersPage() {
    await requireRole([...MY_DEALERS_PAGE_ROLES]);
    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1300px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">My dealers</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    The dealers you own, by days since their last invoice. Orange (31–45 days) is the time to
                    pitch — you get a reminder each morning. Got an order whose invoice is not raised yet? Press
                    &ldquo;Order placed&rdquo; and the reminders pause while accounts raise it.
                </p>
            </header>
            <MyDealersView />
        </div>
    );
}
