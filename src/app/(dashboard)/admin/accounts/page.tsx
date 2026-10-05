import { requireRole } from "@/lib/auth-utils";
import { AccountsView } from "./_components/AccountsView";

export const dynamic = "force-dynamic";

// Tracker P1-1 / P1-2 — dealer accounts: owner, onboarded by, lead vs direct,
// GSTIN. Admin and CEO only (middleware row "/admin/accounts"; the CEO also
// reaches it at /ceo/accounts).
export default async function AccountsPage() {
    await requireRole(["admin", "ceo"]);

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1500px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Accounts</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Onboarded dealer accounts and who owns them. The owner is credited with the account&apos;s
                    invoices from the effective date of each assignment; &ldquo;onboarded by&rdquo; never changes.
                    Nothing is assigned automatically — the suggested owner in the No owner queue is a hint.
                </p>
            </header>
            <AccountsView />
        </div>
    );
}
