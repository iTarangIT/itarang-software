// What the CEO overview's "New dealers live" card is made of: every dealer
// onboarding application approved in the period, with the same rule as
// funnelCounts.ts onboardedQuery (approved_at is a NAIVE UTC timestamp, hence
// istRangeNaive). The count at the top is the card's number.

import Link from "next/link";
import { sql } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { istRangeNaive } from "@/lib/digests/window";

export const dynamic = "force-dynamic";

type Row = {
    id: string;
    company_name: string;
    owner_name: string | null;
    owner_phone: string | null;
    city: string | null;
    state: string | null;
    gst_number: string | null;
    approved_on: string;
    account_id: string | null;
    account_name: string | null;
};

const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const fmtDate = (d: string) =>
    new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
    });

export default async function CeoNewDealersPage({
    searchParams,
}: {
    searchParams: Promise<{ from?: string; to?: string; label?: string }>;
}) {
    await requireRole(["ceo", "admin"]);
    const sp = await searchParams;

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    let from = isDate(sp.from) ? sp.from : `${today.slice(0, 7)}-01`;
    let to = isDate(sp.to) ? sp.to : today;
    if (from > to) [from, to] = [to, from];
    const label = sp.label?.trim() || null;

    const rows = (await db.execute(sql`
        SELECT app.id::text AS id, app.company_name, app.owner_name, app.owner_phone,
               app.city, app.state, app.gst_number,
               (app.approved_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date::text AS approved_on,
               a.id AS account_id, a.business_entity_name AS account_name
          FROM dealer_onboarding_applications app
          LEFT JOIN users u ON u.id = app.dealer_user_id
          LEFT JOIN dealers d ON d.application_id = app.id::text
          LEFT JOIN accounts a ON a.id = COALESCE(u.dealer_id, d.dealer_id)
         WHERE app.approved_at IS NOT NULL
           AND ${istRangeNaive(sql`app.approved_at`, from, to)}
         ORDER BY app.approved_at DESC
    `)) as unknown as Row[];

    const byCity = new Map<string, number>();
    for (const r of rows) {
        const c = r.city?.trim() || "Unknown city";
        byCity.set(c, (byCity.get(c) ?? 0) + 1);
    }
    const cities = [...byCity.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    return (
        <div className="space-y-6 pb-12">
            <div>
                <Link href="/ceo" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-sky hover:underline">
                    <ArrowLeft className="h-3.5 w-3.5" /> CEO overview
                </Link>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-brand-navy">New dealers live</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    {label ? `${label} · ` : ""}
                    {fmtDate(from)} – {fmtDate(to)}. Dealer onboarding applications approved in the period.
                </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-xs font-semibold text-gray-500">Dealers approved</p>
                    <p className="mt-1 text-xl font-bold text-brand-navy">{rows.length}</p>
                    <p className="text-xs text-gray-500">
                        {rows.filter((r) => r.account_id).length} with a dealer account
                    </p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-xs font-semibold text-gray-500">By city</p>
                    <p className="mt-1 text-sm text-gray-800">
                        {cities.length ? cities.map(([c, n]) => `${c} ${n}`).join(" · ") : "—"}
                    </p>
                </div>
            </div>

            {rows.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">
                    No dealer onboarding was approved in this period.
                </p>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="px-4 py-3">Approved on</th>
                                <th className="px-4 py-3">Dealer</th>
                                <th className="px-4 py-3">Owner</th>
                                <th className="px-4 py-3">City</th>
                                <th className="px-4 py-3">GSTIN</th>
                                <th className="px-4 py-3">Account</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {rows.map((r) => (
                                <tr key={r.id} className="align-top">
                                    <td className="whitespace-nowrap px-4 py-3 text-gray-700">{fmtDate(r.approved_on)}</td>
                                    <td className="px-4 py-3">
                                        <Link
                                            href={`/admin/dealer-verification/${encodeURIComponent(r.id)}`}
                                            className="font-medium text-gray-900 hover:text-brand-sky hover:underline"
                                        >
                                            {r.company_name}
                                        </Link>
                                    </td>
                                    <td className="px-4 py-3 text-gray-800">
                                        {r.owner_name ?? "—"}
                                        {r.owner_phone && <span className="block text-xs text-gray-500">{r.owner_phone}</span>}
                                    </td>
                                    <td className="px-4 py-3 text-gray-700">
                                        {[r.city, r.state].filter(Boolean).join(", ") || "—"}
                                    </td>
                                    <td className="px-4 py-3 font-mono text-xs text-gray-700">{r.gst_number ?? "—"}</td>
                                    <td className="px-4 py-3">
                                        {r.account_id ? (
                                            <Link
                                                href={`/admin/accounts/${encodeURIComponent(r.account_id)}`}
                                                className="text-brand-sky hover:underline"
                                            >
                                                {r.account_name ?? r.account_id}
                                            </Link>
                                        ) : (
                                            <span className="text-amber-700">No account yet</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
