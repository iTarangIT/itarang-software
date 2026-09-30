import Link from "next/link";
import { requireRole } from "@/lib/auth-utils";
import { CONTACTABILITY_LABEL, listNumberRepair } from "@/lib/leads/contactability";
import { RepairNumberButton } from "./RepairNumberButton";

export const dynamic = "force-dynamic";

// Tracker ID 36 (handover P2-12): leads whose number is dead or who did not
// answer 6 calls on 6 days within 45 days. They keep their owner of record and
// are out of the working queues until the number is repaired here.
export default async function NumberRepairPage() {
    await requireRole(["admin", "sales_head", "ceo", "business_head", "sales_manager"]);
    const rows = await listNumberRepair();

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Number Repair</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Dead or non-responsive numbers. Fix the number (or confirm it) to put the lead back to work — the owner
                    is kept either way. A connected call also clears it.
                </p>
            </header>
            {rows.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">No numbers to repair.</p>
            ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="px-4 py-2">Dealer</th>
                                <th className="px-4 py-2">Phone</th>
                                <th className="px-4 py-2">Owner</th>
                                <th className="px-4 py-2">Why</th>
                                <th className="px-4 py-2">Since</th>
                                <th className="px-4 py-2" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {rows.map((r) => (
                                <tr key={r.id}>
                                    <td className="px-4 py-2">
                                        <Link href={`/leads/${encodeURIComponent(r.id)}`} className="font-medium text-blue-700 underline">
                                            {r.dealer_name ?? r.id}
                                        </Link>
                                        <div className="text-xs text-gray-500">{r.city ?? ""}</div>
                                    </td>
                                    <td className="px-4 py-2 tabular-nums">{r.phone ?? "—"}</td>
                                    <td className="px-4 py-2 text-gray-600">{r.owner_name ?? "—"}</td>
                                    <td className="px-4 py-2 text-gray-600">
                                        {CONTACTABILITY_LABEL[r.contactability] ?? r.contactability}
                                        {r.contactability_reason ? ` — ${r.contactability_reason}` : ""}
                                    </td>
                                    <td className="px-4 py-2 text-gray-600">
                                        {new Date(r.contactability_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}
                                    </td>
                                    <td className="px-4 py-2 text-right">
                                        <RepairNumberButton leadId={r.id} />
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
