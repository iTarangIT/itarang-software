import Link from "next/link";
import { requireRole } from "@/lib/auth-utils";
import { listEcofyLeads } from "@/lib/ecofy/queries";
import { formatQueueAge, StageBadge, TemperatureBadge } from "./_components/badges";

export const dynamic = "force-dynamic";

// E-305 — leads pushed from Ecofy (docs/ECOFY_INTEGRATION.md §6). Hot first,
// then the oldest queue entry. Default view hides leads returned to Ecofy (S0)
// or closed; ?view=all shows them too.
export default async function EcofyLeadsPage({
    searchParams,
}: {
    searchParams: Promise<{ view?: string }>;
}) {
    await requireRole(["sales_head"]);
    const { view } = await searchParams;
    const showAll = view === "all";
    const leads = await listEcofyLeads({ open: !showAll });

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1600px]">
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Ecofy Leads</h1>
                    <p className="mt-1 text-sm text-gray-600">
                        Leads pushed from Ecofy. Hot first, then the longest waiting.
                    </p>
                </div>
                <nav className="flex rounded-lg border border-gray-200 bg-white p-0.5 text-sm">
                    <Link
                        href="/sales-head/ecofy-leads"
                        className={`rounded-md px-3 py-1.5 ${!showAll ? "bg-gray-900 text-white" : "text-gray-600 hover:text-gray-900"}`}
                    >
                        Open
                    </Link>
                    <Link
                        href="/sales-head/ecofy-leads?view=all"
                        className={`rounded-md px-3 py-1.5 ${showAll ? "bg-gray-900 text-white" : "text-gray-600 hover:text-gray-900"}`}
                    >
                        All
                    </Link>
                </nav>
            </header>

            {leads.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">
                    No {showAll ? "" : "open "}Ecofy leads yet.
                </div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="px-4 py-3">Case</th>
                                <th className="px-4 py-3">Customer</th>
                                <th className="px-4 py-3">Temperature</th>
                                <th className="px-4 py-3">Stage</th>
                                <th className="px-4 py-3">City</th>
                                <th className="px-4 py-3">Product</th>
                                <th className="px-4 py-3">In queue</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {leads.map((l) => (
                                <tr key={l.id} className="hover:bg-gray-50">
                                    <td className="px-4 py-3 font-medium">
                                        <Link
                                            href={`/sales-head/ecofy-leads/${l.id}`}
                                            className="text-blue-700 hover:underline"
                                        >
                                            {l.case_no ?? l.ecofy_case_id.slice(0, 8)}
                                        </Link>
                                    </td>
                                    <td className="px-4 py-3">
                                        <div className="text-gray-900">{l.customer_name ?? "—"}</div>
                                        <div className="text-xs text-gray-500">{l.customer_mobile ?? ""}</div>
                                    </td>
                                    <td className="px-4 py-3">
                                        <TemperatureBadge value={l.temperature} />
                                    </td>
                                    <td className="px-4 py-3">
                                        <StageBadge value={l.stage} />
                                    </td>
                                    <td className="px-4 py-3 text-gray-700">{l.city ?? "—"}</td>
                                    <td className="px-4 py-3 text-gray-700">{l.product_interest ?? "—"}</td>
                                    <td className="px-4 py-3 text-gray-700">{formatQueueAge(l.queue_entered_at)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
