import Link from "next/link";
import { requireRole } from "@/lib/auth-utils";
import { errorMessage } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { crmLeadIdsForCases } from "@/lib/ecofy/queries";
import { readQueue } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

type Asset = {
    id: string;
    caseId: string;
    caseNo: string;
    customerName: string | null;
    city: string | null;
    systemSnapshot: { system: string | null; fileNo: string | null };
    commissionedOn: string;
    status: string;
    emiStatus: { asOf: string; state: string } | null;
    events: Array<{ id: number; type: string; onDate: string }>;
};

// E-307 — active assets (financed, installed systems). Read-only: EMI status
// and buyback / redeployment are recorded by Ecofy Admin.
export default async function EcofyAssetsPage() {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    let rows: Asset[] = [];
    let error: string | null = null;
    try {
        rows = ((await readQueue("assets")) as Asset[]) ?? [];
    } catch (err) {
        error = errorMessage(err);
    }
    const links = await crmLeadIdsForCases(rows.map((r) => r.caseId));

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Ecofy — Assets</h1>
                <p className="mt-1 text-sm text-gray-600">Financed, installed systems. Read-only here — Ecofy Admin records EMI status, buyback and redeployment.</p>
            </header>
            {error && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Ecofy could not be reached: {error}</p>}
            {!error && rows.length === 0 && (
                <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">
                    No assets yet — an asset is created when a disbursement is recorded.
                </div>
            )}
            {rows.length > 0 && (
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="px-4 py-3">Case / File</th>
                                <th className="px-4 py-3">Customer</th>
                                <th className="px-4 py-3">System</th>
                                <th className="px-4 py-3">Commissioned</th>
                                <th className="px-4 py-3">EMI status</th>
                                <th className="px-4 py-3">Lifecycle</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {rows.map((a) => {
                                const leadId = links.get(a.caseId);
                                return (
                                    <tr key={a.id}>
                                        <td className="px-4 py-3 font-medium">
                                            {leadId ? (
                                                <Link href={`/sales-head/ecofy/leads/${leadId}`} className="text-blue-700 hover:underline">
                                                    {a.caseNo}
                                                </Link>
                                            ) : (
                                                a.caseNo
                                            )}
                                            <div className="font-mono text-xs text-gray-500">{a.systemSnapshot?.fileNo}</div>
                                        </td>
                                        <td className="px-4 py-3">
                                            {a.customerName}
                                            <div className="text-xs text-gray-500">{a.city}</div>
                                        </td>
                                        <td className="px-4 py-3">{a.systemSnapshot?.system ?? "—"}</td>
                                        <td className="px-4 py-3 text-xs">{a.commissionedOn}</td>
                                        <td className="px-4 py-3">
                                            {a.emiStatus ? (
                                                <>
                                                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${a.emiStatus.state === "CURRENT" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
                                                        {a.emiStatus.state.replace(/_/g, " ")}
                                                    </span>
                                                    <div className="text-xs text-gray-500">as of {a.emiStatus.asOf}</div>
                                                </>
                                            ) : (
                                                <span className="text-xs text-gray-500">no EMI status</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">{a.status}</span>
                                            {a.events?.length ? <div className="text-xs text-gray-500">{a.events.map((e) => `${e.onDate}: ${e.type}`).join(" · ")}</div> : null}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
