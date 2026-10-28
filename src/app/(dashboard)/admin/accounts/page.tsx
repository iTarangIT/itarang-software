import { requireRole } from "@/lib/auth-utils";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";
import { AccountsListQuerySchema, listAccountsPage } from "@/lib/accounts/accountsPage";
import { AccountsView, type ListResponse } from "./_components/AccountsView";

export const dynamic = "force-dynamic";

// Tracker P1-1 / P1-2 — dealer accounts: owner, onboarded by, lead vs direct,
// GSTIN. Admin and CEO only (middleware row "/admin/accounts"; the CEO also
// reaches it at /ceo/accounts).
export default async function AccountsPage() {
    await requireRole(["admin", "ceo", "sales_head"]);

    // ID 203: page 1 of the default tab runs here, so the list arrives with the
    // HTML. On any failure the view fetches it itself, as before.
    let initialPage: ListResponse | null = null;
    try {
        if (await hasAccountOwnershipTables()) {
            initialPage = (await listAccountsPage(AccountsListQuerySchema.parse({ limit: 100, offset: 0 }))) as ListResponse;
        }
    } catch (e) {
        console.warn("[admin/accounts] server first page skipped:", e instanceof Error ? e.message : e);
    }

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
            <AccountsView initialPage={initialPage} />
        </div>
    );
}
