import { requireRole } from "@/lib/auth-utils";
import { errorMessage } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { crmLeadIdsForCases } from "@/lib/ecofy/queries";
import { readQueue } from "@/lib/ecofy/service";
import { EcofyQueueGrid, type QueueColumn, type QueueRow } from "@/components/ecofy/EcofyQueueGrid";

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

const COLUMNS: QueueColumn[] = [
    { key: "case", label: "Case", filter: "text" },
    { key: "file", label: "File", filter: "text", mono: true },
    { key: "customer", label: "Customer", filter: "text" },
    { key: "city", label: "City", filter: "select" },
    { key: "system", label: "System", filter: "text" },
    { key: "commissioned", label: "Commissioned", date: true },
    { key: "emi", label: "EMI status", filter: "select" },
    { key: "lifecycle", label: "Lifecycle", filter: "select" },
];

// E-307 — active assets (financed, installed systems). Read-only: EMI status
// and buyback / redeployment are recorded by Ecofy Admin. Search, filters,
// date range and CSV are client-side (EcofyQueueGrid).
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

    const gridRows: QueueRow[] = rows.map((a) => {
        const leadId = links.get(a.caseId);
        const emiState = a.emiStatus ? a.emiStatus.state.replace(/_/g, " ") : "no EMI status";
        const events = a.events?.length ? a.events.map((e) => `${e.onDate}: ${e.type}`).join(" · ") : "";
        return {
            id: a.id,
            cells: {
                case: { text: a.caseNo, href: leadId ? `/sales-head/ecofy/leads/${leadId}` : undefined },
                file: { text: a.systemSnapshot?.fileNo ?? "" },
                customer: { text: a.customerName ?? "" },
                city: { text: a.city ?? "" },
                system: { text: a.systemSnapshot?.system ?? "" },
                commissioned: { text: a.commissionedOn, node: <span className="text-xs">{a.commissionedOn}</span> },
                emi: {
                    text: emiState,
                    sub: a.emiStatus ? `as of ${a.emiStatus.asOf}` : null,
                    node: a.emiStatus ? (
                        <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                a.emiStatus.state === "CURRENT" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"
                            }`}
                        >
                            {emiState}
                        </span>
                    ) : (
                        <span className="text-xs text-gray-500">no EMI status</span>
                    ),
                },
                lifecycle: {
                    text: a.status,
                    sub: events || null,
                    node: <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">{a.status}</span>,
                },
            },
        };
    });

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Ecofy — Assets</h1>
                <p className="mt-1 text-sm text-gray-600">Financed, installed systems. Read-only here — Ecofy Admin records EMI status, buyback and redeployment.</p>
            </header>
            {error && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Ecofy could not be reached: {error}</p>}
            {!error && (
                <EcofyQueueGrid
                    columns={COLUMNS}
                    rows={gridRows}
                    csvName="ecofy-assets"
                    emptyText="No assets yet — an asset is created when a disbursement is recorded."
                    searchPlaceholder="Search by case, file, customer, city or system…"
                />
            )}
        </div>
    );
}
