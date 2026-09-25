import Link from "next/link";
import { requireRole } from "@/lib/auth-utils";
import { errorMessage } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { crmLeadIdsForCases } from "@/lib/ecofy/queries";
import { readQueue } from "@/lib/ecofy/service";
import { formatIst } from "@/components/ecofy/badges";
import { EligibilityDecision } from "@/components/ecofy/EligibilityDecision";

export const dynamic = "force-dynamic";

type Row = {
    id: string;
    caseNo: string;
    segment: string;
    customer: { fullName: string; city: string | null } | null;
    ageing: { inStageWorkingHours: number };
    eligibility: { id: string; status: string; requestedAt: string; reason: string | null };
};

// E-307 — cases waiting for an eligibility decision on a financier whose
// values iTarang Admin may see (Ecofy's /eligibility-queue).
export default async function EcofyEligibilityPage() {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    let rows: Row[] = [];
    let error: string | null = null;
    try {
        rows = ((await readQueue("eligibility")) as Row[]) ?? [];
    } catch (err) {
        error = errorMessage(err);
    }
    const links = await crmLeadIdsForCases(rows.map((r) => r.id));

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Ecofy — Eligibility queue</h1>
                <p className="mt-1 text-sm text-gray-600">
                    Record the financier&apos;s result: Eligible (maximum amount, hidden from callers), Not eligible (reason) or Info needed.
                </p>
            </header>
            {error && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Ecofy could not be reached: {error}</p>}
            {!error && rows.length === 0 && (
                <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">Nothing awaiting eligibility.</div>
            )}
            {rows.length > 0 && (
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="px-4 py-3">Case</th>
                                <th className="px-4 py-3">Customer</th>
                                <th className="px-4 py-3">Segment</th>
                                <th className="px-4 py-3">Requested</th>
                                <th className="px-4 py-3">Waiting</th>
                                <th className="px-4 py-3">Status</th>
                                <th className="px-4 py-3" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {rows.map((r) => {
                                const leadId = links.get(r.id);
                                return (
                                    <tr key={r.eligibility.id} className="align-top">
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
                                        <td className="px-4 py-3">{r.segment}</td>
                                        <td className="px-4 py-3 text-xs">{formatIst(r.eligibility.requestedAt)}</td>
                                        <td className="px-4 py-3">{r.ageing?.inStageWorkingHours ?? "—"} wh</td>
                                        <td className="px-4 py-3">
                                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">{r.eligibility.status}</span>
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            <EligibilityDecision eligibilityId={r.eligibility.id} caseId={r.id} caseNo={r.caseNo} />
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
