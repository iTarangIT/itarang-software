import Link from "next/link";
import { requireRole } from "@/lib/auth-utils";
import { errorMessage } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { assetDetailSections } from "@/lib/ecofy/assetView";
import { crmLeadIdsForCases } from "@/lib/ecofy/queries";
import { readAsset } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

// Tracker ID 51 gap 9 — one asset (GET /assets/{assetId}). Read-only by
// contract: EMI status and buyback / redeployment are written by Ecofy Admin
// only (BRD FR-13.2/FR-13.3; OpenAPI x-roles ECOFY_ADMIN). Amounts Ecofy hides
// from iTarang Admin stay hidden (UAT-27): the page renders what Ecofy returns.
export default async function EcofyAssetDetailPage({ params }: { params: Promise<{ assetId: string }> }) {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    const { assetId } = await params;
    let asset: Record<string, unknown> | null = null;
    let error: string | null = null;
    try {
        asset = await readAsset(assetId);
    } catch (err) {
        error = errorMessage(err);
    }
    const caseId = typeof asset?.caseId === "string" ? asset.caseId : null;
    const leadId = caseId ? (await crmLeadIdsForCases([caseId])).get(caseId) : undefined;
    const sections = asset ? assetDetailSections(asset) : [];
    const title = (typeof asset?.caseNo === "string" && asset.caseNo) || assetId.slice(0, 8);

    return (
        <div className="mx-auto max-w-[1200px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Ecofy — Asset {title}</h1>
                    <p className="mt-1 text-sm text-gray-600">
                        Recorded in Ecofy. EMI status, buyback and redeployment are entered by Ecofy Admin; the CRM only shows them.
                    </p>
                </div>
                <div className="flex gap-3 text-sm">
                    {leadId && (
                        <Link href={`/sales-head/ecofy/leads/${leadId}`} className="text-blue-700 hover:underline">
                            Open the lead →
                        </Link>
                    )}
                    <Link href="/sales-head/ecofy/assets" className="text-blue-700 hover:underline">
                        ← All assets
                    </Link>
                </div>
            </header>
            {error && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Ecofy could not be reached: {error}</p>}
            {!error && !asset && <p className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">Ecofy returned no asset for this id.</p>}
            {sections.map((sec) => (
                <section key={sec.title} className="rounded-xl border border-gray-200 bg-white shadow-sm">
                    <h2 className="border-b border-gray-100 px-4 py-3 text-sm font-semibold text-gray-900">{sec.title}</h2>
                    <div className="p-4">
                        {sec.table ? (
                            <div className="overflow-x-auto">
                                <table className="min-w-full text-sm">
                                    <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                                        <tr>
                                            {sec.table.columns.map((c) => (
                                                <th key={c} className="py-1 pr-4">
                                                    {c}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                        {sec.table.rows.map((r, i) => (
                                            <tr key={i}>
                                                {r.map((cell, j) => (
                                                    <td key={j} className="py-1.5 pr-4 text-gray-900">
                                                        {cell}
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : sec.rows && sec.rows.length > 0 ? (
                            <dl className="grid grid-cols-[200px_1fr] gap-x-3 gap-y-1.5 text-sm">
                                {sec.rows.map(([k, v]) => (
                                    <div key={k} className="contents">
                                        <dt className="text-gray-500">{k}</dt>
                                        <dd className="break-words text-gray-900">{v}</dd>
                                    </div>
                                ))}
                            </dl>
                        ) : (
                            <p className="text-sm text-gray-500">Nothing recorded.</p>
                        )}
                    </div>
                </section>
            ))}
        </div>
    );
}
