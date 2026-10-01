import Link from "next/link";
import { requireRole } from "@/lib/auth-utils";
import { listReadyToAssign } from "@/lib/leads/salesReady";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

export const dynamic = "force-dynamic";

// Tracker ID 82 (handover P2-10): sales-ready leads nobody owns, oldest wait
// first. The wait is counted from the Sales-ready event, not from creation —
// the same clock as the CEO card "Sales-ready leads awaiting assignment".
export default async function ReadyToAssignPage() {
    await requireRole(["admin", "sales_head", "ceo", "business_head", "sales_manager"]);
    const rows = await listReadyToAssign();

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Ready to assign</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Leads that became sales-ready and have no owner. Open one and assign it; the wait is counted from
                    the Sales-ready event.
                </p>
            </header>
            {rows.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">
                    Nothing is waiting — every sales-ready lead has an owner.
                </p>
            ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="px-4 py-2">Dealer</th>
                                <th className="px-4 py-2">Location</th>
                                <th className="px-4 py-2">Status</th>
                                <th className="px-4 py-2">Temperature</th>
                                <th className="px-4 py-2">Sales-ready because</th>
                                <th className="px-4 py-2 text-right">Waiting (days)</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {rows.map((r) => (
                                <tr key={r.id} className="hover:bg-gray-50">
                                    <td className="px-4 py-2">
                                        <Link href={`/leads/${encodeURIComponent(r.id)}`} className="font-medium text-blue-700 underline">
                                            {r.dealer_name ?? r.id}
                                        </Link>
                                    </td>
                                    <td className="px-4 py-2 text-gray-600">{[r.city, r.state].filter(Boolean).join(", ") || "—"}</td>
                                    <td className="px-4 py-2 text-gray-600">
                                        {r.lead_status ? (LEAD_STATUS_LABEL[r.lead_status as LeadStatus] ?? r.lead_status) : "—"}
                                    </td>
                                    <td className="px-4 py-2 text-gray-600">{r.interest_level ?? "—"}</td>
                                    <td className="px-4 py-2 text-gray-600">{(r.sales_ready_reason ?? "").replace(/_/g, " ")}</td>
                                    <td className="px-4 py-2 text-right tabular-nums">{r.days_waiting}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
