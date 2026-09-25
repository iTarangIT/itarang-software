import Link from "next/link";
import { requireRole } from "@/lib/auth-utils";
import { errorMessage } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { crmLeadIdsForCases } from "@/lib/ecofy/queries";
import { readQueue } from "@/lib/ecofy/service";
import { formatIst, inr, StageBadge } from "@/components/ecofy/badges";

export const dynamic = "force-dynamic";

type Row = {
    id: string;
    caseNo: string;
    segment: string;
    stage: string;
    subStatus: string | null;
    customer: { fullName: string; city: string | null } | null;
    ageing: { inStageWorkingHours: number };
    decision: { id: string; attemptNo: number; submittedAt: string };
    file: { fileNo: string; acceptedTotalInr: number } | null;
};

// E-307 — Files awaiting a financing decision for financiers iTarang Admin
// may see (Ecofy's /financing-queue). The decision is recorded on the lead's
// Financing tab.
export default async function EcofyFinancingPage() {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    let rows: Row[] = [];
    let error: string | null = null;
    try {
        rows = ((await readQueue("financing")) as Row[]) ?? [];
    } catch (err) {
        error = errorMessage(err);
    }
    const links = await crmLeadIdsForCases(rows.map((r) => r.id));

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Ecofy — Financing queue</h1>
                <p className="mt-1 text-sm text-gray-600">
                    Files waiting for the financier&apos;s decision. Open a lead and record Sanctioned or Rejected on its Financing tab.
                </p>
            </header>
            {error && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Ecofy could not be reached: {error}</p>}
            {!error && rows.length === 0 && (
                <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">No Files awaiting a decision.</div>
            )}
            {rows.length > 0 && (
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="px-4 py-3">File</th>
                                <th className="px-4 py-3">Case</th>
                                <th className="px-4 py-3">Customer</th>
                                <th className="px-4 py-3">Accepted total</th>
                                <th className="px-4 py-3">Attempt</th>
                                <th className="px-4 py-3">Submitted</th>
                                <th className="px-4 py-3">Waiting</th>
                                <th className="px-4 py-3">Stage</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {rows.map((r) => {
                                const leadId = links.get(r.id);
                                return (
                                    <tr key={r.decision.id}>
                                        <td className="px-4 py-3 font-mono text-xs">{r.file?.fileNo ?? "—"}</td>
                                        <td className="px-4 py-3 font-medium">
                                            {leadId ? (
                                                <Link href={`/sales-head/ecofy/leads/${leadId}`} className="text-blue-700 hover:underline">
                                                    {r.caseNo}
                                                </Link>
                                            ) : (
                                                r.caseNo
                                            )}
                                        </td>
                                        <td className="px-4 py-3">
                                            {r.customer?.fullName}
                                            <div className="text-xs text-gray-500">{r.customer?.city}</div>
                                        </td>
                                        <td className="px-4 py-3">{inr(r.file?.acceptedTotalInr)}</td>
                                        <td className="px-4 py-3">{r.decision.attemptNo}</td>
                                        <td className="px-4 py-3 text-xs">{formatIst(r.decision.submittedAt)}</td>
                                        <td className="px-4 py-3">{r.ageing?.inStageWorkingHours ?? "—"} wh</td>
                                        <td className="px-4 py-3">
                                            <StageBadge value={r.stage} subStatus={r.subStatus} />
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
