import { requireRole } from "@/lib/auth-utils";
import { errorMessage } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { crmLeadIdsForCases } from "@/lib/ecofy/queries";
import { readQueue } from "@/lib/ecofy/service";
import { formatIst } from "@/components/ecofy/badges";
import { EligibilityDecision } from "@/components/ecofy/EligibilityDecision";
import { EcofyQueueGrid, type QueueColumn, type QueueRow } from "@/components/ecofy/EcofyQueueGrid";

export const dynamic = "force-dynamic";

type Row = {
    id: string;
    caseNo: string;
    segment: string;
    customer: { fullName: string; city: string | null } | null;
    ageing: { inStageWorkingHours: number };
    eligibility: { id: string; status: string; requestedAt: string; reason: string | null };
};

const COLUMNS: QueueColumn[] = [
    { key: "case", label: "Case", filter: "text" },
    { key: "customer", label: "Customer", filter: "text" },
    { key: "city", label: "City", filter: "select" },
    { key: "segment", label: "Segment", filter: "select" },
    { key: "requested", label: "Requested", date: true },
    { key: "waiting", label: "Waiting" },
    { key: "status", label: "Status", filter: "select" },
];

// E-307 — cases waiting for an eligibility decision on a financier whose
// values iTarang Admin may see (Ecofy's /eligibility-queue). Search, filters,
// date range and CSV are client-side (EcofyQueueGrid).
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

    const gridRows: QueueRow[] = rows.map((r) => {
        const leadId = links.get(r.id);
        return {
            id: r.eligibility.id,
            cells: {
                case: { text: r.caseNo, href: leadId ? `/sales-head/ecofy/leads/${leadId}` : undefined },
                customer: { text: r.customer?.fullName ?? "" },
                city: { text: r.customer?.city ?? "" },
                segment: { text: r.segment === "CI" ? "C&I" : r.segment },
                requested: { text: r.eligibility.requestedAt, node: <span className="text-xs">{formatIst(r.eligibility.requestedAt)}</span> },
                waiting: { text: r.ageing?.inStageWorkingHours != null ? `${r.ageing.inStageWorkingHours} wh` : "" },
                status: {
                    text: r.eligibility.status,
                    node: <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">{r.eligibility.status}</span>,
                },
            },
            action: <EligibilityDecision eligibilityId={r.eligibility.id} caseId={r.id} caseNo={r.caseNo} />,
        };
    });

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Ecofy — Eligibility queue</h1>
                <p className="mt-1 text-sm text-gray-600">
                    Record the financier&apos;s result: Eligible (maximum amount, hidden from callers), Not eligible (reason) or Info needed.
                </p>
            </header>
            {error && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Ecofy could not be reached: {error}</p>}
            {!error && (
                <EcofyQueueGrid
                    columns={COLUMNS}
                    rows={gridRows}
                    csvName="ecofy-eligibility-queue"
                    emptyText="Nothing awaiting eligibility."
                    searchPlaceholder="Search by case no., customer or city…"
                />
            )}
        </div>
    );
}
