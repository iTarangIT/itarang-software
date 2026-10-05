import Link from "next/link";
import { sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { ACCOUNT_MANAGE_ROLES } from "@/lib/accounts/access";
import { countAccounts, listAccounts } from "@/lib/accounts/accountList";
import { ACCOUNT_BUCKETS, ACCOUNT_BUCKET_LABELS, type AccountBucket } from "@/lib/dealers/accountHealthRules";
import { listSalespeople, SALESPERSON_ROLE_LABEL } from "@/lib/onboarding/salesperson";
import { AccountManagementTable } from "./AccountManagementTable";

export const dynamic = "force-dynamic";

// Tracker ID 65 (handover P1-1 / P1-2): after activation a dealer is an
// account. This page is where Admin, CEO and the Sales Head see every account
// with who onboarded it and who owns it, tag the ones with no owner, reassign
// one or many, move a leaver's accounts in one step, and correct a missing or
// wrong GSTIN. Owner changes are recorded with a reason and an effective date
// and never edit the onboarding.
export default async function AccountManagementPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | undefined>>;
}) {
    await requireRole([...ACCOUNT_MANAGE_ROLES]);
    const p = await searchParams;
    const bucket = (ACCOUNT_BUCKETS as readonly string[]).includes(p.bucket ?? "") ? (p.bucket as AccountBucket) : null;
    const came = p.came_through === "lead" || p.came_through === "direct" ? p.came_through : null;
    const noOwner = p.no_owner === "1";
    const gstinMissing = p.gstin_missing === "1";

    const [rows, counts, salespeople, currentOwners, onboarders] = await Promise.all([
        listAccounts({
            ownerId: p.owner || null,
            onboardedById: p.onboarded_by || null,
            cameThrough: came,
            bucket,
            noOwnerOnly: noOwner,
            gstinMissingOnly: gstinMissing,
            search: p.search ?? null,
        }),
        countAccounts(),
        listSalespeople(),
        // Everyone who owns at least one account today — including people who
        // are no longer active, which is exactly who a leaver move is for.
        db.execute(sql`
            SELECT u.id::text AS id, u.name, u.is_active, COUNT(*)::int AS accounts
              FROM accounts a JOIN users u ON u.id = a.account_owner_id
             GROUP BY u.id, u.name, u.is_active
             ORDER BY u.name
        `) as unknown as Promise<{ id: string; name: string; is_active: boolean; accounts: number }[]>,
        db.execute(sql`
            SELECT u.id::text AS id, u.name, COUNT(*)::int AS accounts
              FROM accounts a JOIN users u ON u.id = a.onboarded_by_user_id
             GROUP BY u.id, u.name
             ORDER BY u.name
        `) as unknown as Promise<{ id: string; name: string; accounts: number }[]>,
    ]);

    const tab = (href: string, label: string, n: number, active: boolean) => (
        <Link
            href={href}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                active ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
            }`}
        >
            {label} · {n.toLocaleString("en-IN")}
        </Link>
    );
    const selectCls = "rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm text-gray-700";

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1500px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Account management</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Every activated dealer, with who onboarded it and who owns it now. Assigning or changing an owner
                    needs a reason and an effective date; the onboarding record is never edited.
                </p>
            </header>

            <div className="flex flex-wrap items-center gap-2">
                {tab("/admin/account-management", "All accounts", counts.total, !noOwner && !gstinMissing)}
                {tab("/admin/account-management?no_owner=1", "No owner", counts.no_owner, noOwner)}
                {tab("/admin/account-management?gstin_missing=1", "GSTIN missing", counts.gstin_missing, gstinMissing)}
            </div>

            <form method="get" className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-3">
                {noOwner && <input type="hidden" name="no_owner" value="1" />}
                {gstinMissing && <input type="hidden" name="gstin_missing" value="1" />}
                <input
                    name="search"
                    defaultValue={p.search ?? ""}
                    placeholder="Search dealer, GSTIN or city…"
                    className={`${selectCls} min-w-[220px] flex-1`}
                />
                {!noOwner && (
                    <select name="owner" defaultValue={p.owner ?? ""} className={selectCls} aria-label="Account owner">
                        <option value="">All owners</option>
                        {currentOwners.map((o) => (
                            <option key={o.id} value={o.id}>
                                {o.name}
                                {o.is_active ? "" : " (inactive)"} · {o.accounts}
                            </option>
                        ))}
                    </select>
                )}
                <select name="onboarded_by" defaultValue={p.onboarded_by ?? ""} className={selectCls} aria-label="Onboarded by">
                    <option value="">Onboarded by: anyone</option>
                    {onboarders.map((o) => (
                        <option key={o.id} value={o.id}>
                            {o.name} · {o.accounts}
                        </option>
                    ))}
                </select>
                <select name="came_through" defaultValue={came ?? ""} className={selectCls} aria-label="Came through">
                    <option value="">Came through: any</option>
                    <option value="lead">Lead</option>
                    <option value="direct">Direct onboarding</option>
                </select>
                <select name="bucket" defaultValue={bucket ?? ""} className={selectCls} aria-label="Health">
                    <option value="">Health: any</option>
                    {ACCOUNT_BUCKETS.map((b) => (
                        <option key={b} value={b}>
                            {ACCOUNT_BUCKET_LABELS[b]}
                        </option>
                    ))}
                </select>
                <button type="submit" className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white">
                    Apply
                </button>
                <Link href="/admin/account-management" className="text-sm text-gray-500 underline">
                    Clear
                </Link>
            </form>

            <AccountManagementTable
                rows={rows}
                owners={salespeople.map((s) => ({
                    id: s.id,
                    label: `${s.name} — ${SALESPERSON_ROLE_LABEL[s.role.toLowerCase() as keyof typeof SALESPERSON_ROLE_LABEL] ?? s.role}`,
                }))}
                currentOwners={currentOwners.map((o) => ({
                    id: o.id,
                    label: `${o.name}${o.is_active ? "" : " (inactive)"} · ${o.accounts} account${o.accounts === 1 ? "" : "s"}`,
                }))}
                bucketLabels={ACCOUNT_BUCKET_LABELS}
            />
        </div>
    );
}
